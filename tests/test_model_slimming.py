"""The processor's model-slimming columns match the ValueLens DAX calculated columns they replace.

The notebook (section 10c) and core/valuelens_core/processor.py write 26 physical columns that used
to be DAX calculated columns on 'Chat + Agent Interactions (Audit Logs)'. tests/valuelens_golden.py
already proves the two processors agree; this file checks both against an independent reference
written from the original DAX (session/message "type blobs" built CONCATENATEX-style, text
compared case-insensitively as the engine does, Assumptions[Fit Grading] at its "Balanced"
default because calculated columns see no slicer), and checks the behaviour-group lookup still
matches the 'Behavior Value Map' / 'Human Time Estimates' tables in the shipped templates.
"""
import ast
import hashlib
import importlib.util
import json
import re
import tempfile
import unittest
import zipfile
from collections import defaultdict
from pathlib import Path

from valuelens_core import processor

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "tests" / "fixtures" / "valuelens-golden" / "expected"
NOTEBOOK = ROOT / "fabric" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"
TEMPLATES = [ROOT / "fabric" / "ValueLens - Fabric.pbit", ROOT / "fabric" / "ValueLens - Fabric OneLake.pbit"]

# 'Is Material Ref' (non-Cowork rows): the bare file-type tokens the DAX column accepted.
DAX_MATERIAL = {"docx", "doc", "xlsx", "xlsm", "xls", "csv", "pptx", "ppt", "pdf", "txt", "md", "html", "htm",
                "json", "xml", "py", "zip", "png", "jpg", "jpeg", "gif", "mp4", "loop", "aspx", "sitepagemodern",
                "onepart", "page", "eml", "msg", "emailmessage", "teamsmessage", "event", "file", "external",
                "report"}


# --- template tables -------------------------------------------------------------------------
VALUE = re.compile(r'"((?:[^"]|"")*)"|(-?\d+(?:\.\d+)?|null|true|false)\b')


def m_values(line):
    return [s.replace('""', '"') if s or not other else other for s, other in VALUE.findall(line)]


def m_table(expression):
    """(header, rows) of a `#table({header}, {{row}, ...})` literal; values are text."""
    text = "\n".join(expression) if isinstance(expression, list) else expression
    body = text.split("#table(", 1)[1].split('#"Changed Type"', 1)[0]
    lines = [ln.strip() for ln in body.splitlines()]
    literal = [ln for ln in lines if ln.startswith('{"')]
    header = m_values(literal[0])
    rows = []
    for ln in literal[1:]:
        if re.match(r'\{"(?:[^"]|"")*",\s*(?:type\b|[\w.]+\.Type\b)', ln):
            break  # column-type list after the data
        rows.append(m_values(ln))
    return header, rows


def template_behavior_groups(path):
    with zipfile.ZipFile(path) as z:
        model = json.loads(z.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))["model"]
    tables = {t["name"]: t for t in model["tables"]}

    def table(name):
        header, rows = m_table(tables[name]["partitions"][0]["source"]["expression"])
        short = [r for r in rows if len(r) != len(header)]
        if short:
            raise AssertionError(f"{name}: cannot read rows {short[:2]}")
        return [dict(zip(header, r)) for r in rows]

    bvm = table("Behavior Value Map")
    hte = table("Human Time Estimates")
    mapped = {r["Behavior"].lower() for r in bvm}
    category = {}
    for r in hte:
        category.setdefault(r["Behavior"].lower(), r["Category"])
    return {k: v for k, v in category.items() if k in mapped}, bvm, hte


def notebook_constant(name):
    nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    for cell in nb["cells"]:
        if cell["cell_type"] != "code":
            continue
        try:
            tree = ast.parse("".join(cell["source"]))
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
                return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in the notebook")


# --- DAX reference -----------------------------------------------------------------------------
def dax_trim(v):
    return re.sub(" {2,}", " ", ("" if v is None else str(v)).strip(" "))


def ci(v):
    return None if v is None else str(v).lower()


def has(text, *subs):
    return any(s in text for s in subs)


def blob(rows):
    return "|".join(sorted({dax_trim(r["AccessedResource_Type"]).lower() for r in rows}))


def surfaces(s):
    k = f"|{s}|"
    tok = lambda *t: any(f"|{x}|" in k for x in t)
    flags = [
        ("Excel", has(s, "spreadsheetml", "ms-excel", "text/csv") or tok("xlsx", "xlsm", "xls", "csv")),
        ("Word", has(s, "wordprocessingml", "msword") or tok("docx", "doc")),
        ("PowerPoint", has(s, "presentationml", "ms-powerpoint") or tok("pptx", "ppt")),
        ("Outlook", has(s, "rfc822", "ms-outlook") or tok("emailmessage", "eml", "msg", "event")),
        ("PDF", "application/pdf" in s or tok("pdf")),
        ("Teams", tok("teamsmessage")),
    ]
    build = has(s, "application/zip", "application/gzip", "octet-stream", "text/html", "application/json",
                "application/xml") or tok("zip", "gz", "html", "htm", "json", "xml", "py", "ps1", "js", "ts",
                                          "ipynb", "sh")
    return sum(f for _, f in flags), ", ".join(n for n, f in flags if f), int(build)


def tier_sort(model):
    if model is None or "no model logged" in model.lower():
        return 8
    m = model.lower()
    if has(m, "opus", "gpt-6"):
        return 0
    if has(m, "sonnet", "claude", "gpt-5", "gpt-4"):
        return 1
    return 9


def expertise(r):
    t, a = dax_trim(r["AccessedResource_Type"]).lower(), dax_trim(r["AccessedResource_Action"]).lower()
    active = has(a, "send", "draft", "create", "post", "invoke", "write", "patch", "execute")
    reader = not active and a == "read"
    if t in ("message/rfc822", "application/vnd.ms-outlook"):
        return "Communications Specialist" if active else "Executive Assistant"
    if t == "message":
        return "Collaboration Lead"
    if t in ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel",
             "application/vnd.ms-excel.sheet.macroenabled.12", "text/csv"):
        return "Spreadsheet Specialist"
    if t == "application/pdf":
        return "Researcher"
    if t in ("application/json", "application/xml", "text/xml", "text/html", "text/plain"):
        return "Software Engineer"
    if t in ("image/png", "image/jpeg", "image/gif"):
        return "Visual Designer"
    if t in ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword",
             "application/rtf"):
        return "Knowledge Navigator" if reader else "Content Writer"
    if t in ("application/vnd.openxmlformats-officedocument.presentationml.presentation",
             "application/vnd.ms-powerpoint"):
        return "Knowledge Navigator" if reader else "Presentation Designer"
    return None


def key(v):
    return None if v is None else int(hashlib.md5(str(v).lower().encode("utf-8")).hexdigest()[:15], 16)


def reference(rows, groups):
    out = []
    for r in rows:
        cowork = "cowork" in (r["AppHost"] or "").lower()
        host = dax_trim(r["AppHost"])
        prompt = dax_trim(r["Message_isPrompt"]).upper() in ("TRUE", "1")
        t = dax_trim(r["AccessedResource_Type"]).lower()
        out.append({
            "Is_Cowork": cowork,
            "AppHost_Norm": "Teams" if host.lower() == "microsoft teams" else host,
            "Agent Filter (Normalized)": "Cowork" if cowork else (
                "Agents" if r["Is_Agent_Activity"] is True or len(dax_trim(r["AgentId"])) > 0 else "Copilot"),
            "Is Prompt Row": prompt,
            "Is Observed Prompt": prompt and all(len(("" if r[c] is None else str(r[c])).strip(" ")) > 0
                                                 for c in ("Audit_UserId", "Message_Id", "ThreadId")),
            "Model Cost Tier Sort": tier_sort(r["AI_Model"]),
            "Expertise Role (All Cohorts)": expertise(r) if cowork else r["Expertise_Role"],
            "_material": (r["AccessedResource_Type"] is not None and len(t) > 0 and t != "message") if cowork
            else t in DAX_MATERIAL,
        })
    threads, messages = defaultdict(list), defaultdict(list)
    for r, o in zip(rows, out):
        threads[ci(r["ThreadId"])].append((r, o))
        messages[ci(r["Message_Id"])].append((r, o))

    for r, o in zip(rows, out):
        group = threads[ci(r["ThreadId"])]
        n = len(group)
        refs = sum(1 for _, g in group if g["_material"]) or None
        types = len({ci(gr["AccessedResource_Type"]) for gr, g in group if g["_material"]}) or None
        reads = sum(1 for gr, _ in group if ci(gr["AccessedResource_Type"]) == "message") if o["Is_Cowork"] else 0
        surf, surf_list, build = surfaces(blob([gr for gr, _ in group]))
        m, b = refs or 0, types or 0
        step = (1 if surf >= 2 else 2 if build == 1 else 3 if (m >= 3 and b >= 2) or m > 5
                else 8 if m == 0 and reads > 0 else 4 if m == 0 else 5 if b >= 2 or m >= 3
                else 10 if surf == 1 else 7)
        band = 9 if r["ThreadId"] is None else 1 if n == 1 else 2 if n <= 3 else 3 if n <= 6 else 4
        low = min(g["Model Cost Tier Sort"] for _, g in group)
        mtier = o["Model Cost Tier Sort"]
        o.update({
            "Session Turn Band Sort": band,
            "Session Turn Band": {9: "Not recorded", 1: "1 turn", 2: "2-3 turns", 3: "4-6 turns", 4: "7+ turns"}[band],
            "Model Cost Tier": {8: "Not attributed", 0: "Frontier (premium cost)",
                                1: "Workhorse (mid cost)"}.get(mtier, "Unclassified"),
            "Session Material Refs": refs,
            "Session Material Types": types,
            "Work Weight Grade": {1: "Strong fit", 2: "Strong fit", 3: "Strong fit", 4: "Worth a look",
                                  5: "Fair fit", 8: "Fair fit", 10: "Fair fit"}.get(step, "Unclassified"),
            "Work Weight Grade Sort": {1: 0, 2: 0, 3: 0, 5: 1, 8: 1, 10: 1, 4: 2}.get(step, 3),
            "Work Shape": {1: "Cross-app chain", 2: "Builds an artifact", 3: "Multi-source synthesis",
                           4: "Chat only", 5: "Moderate sourcing", 8: "Read messages",
                           10: "Single-app task"}.get(step, "Not enough detail"),
            "Work Shape Sort": {1: 0, 2: 1, 3: 2, 5: 3, 10: 4, 8: 5, 4: 7}.get(step, 8),
            "Fit Basis": {1: f"Spans {surf_list}", 2: "Built or packaged an artifact", 3: "Multi-source synthesis",
                          4: "Chat only - nothing attached", 5: "Mixed or repeated sources",
                          8: "Read messages - nothing attached",
                          10: f"Worked in one app ({surf_list})"}.get(step, "Insufficient evidence"),
            "Session Model Tier": {0: "Frontier (premium cost)", 1: "Workhorse (mid cost)"}.get(low, "Not attributed"),
            "Session Model Tier Sort": {0: 1, 1: 2}.get(low, 3),
            "Is Usage Row": o["Is Prompt Row"] or o["Is_Cowork"],
            "Thread_Key": key(r["ThreadId"]),
            "Message_Key": key(r["Message_Id"]),
        })
        _t = blob([gr for gr, _ in messages[ci(r["Message_Id"])]])
        if o["Is_Cowork"]:
            category = ("Email workflows" if has(_t, "rfc822", "ms-outlook")
                        else "Analysis & Research" if has(_t, "spreadsheetml", "text/csv", "application/json",
                                                         "application/xml", "application/pdf", "application/zip",
                                                         "application/gzip")
                        else "Document & content creation" if has(_t, "wordprocessingml", "presentationml",
                                                                  "ms-powerpoint", "text/markdown", "text/html",
                                                                  "image/")
                        else "Communication workflows" if "message" in _t else "General assistance / Other")
            mode = ("4 - Producing" if "text/markdown" in _t
                    else "3 - Consuming" if has(_t, "officedocument", "application/", "image/", "text/csv",
                                                "text/html", "text/plain", "rfc822", "ms-outlook", "ms-powerpoint")
                    else "2 - Finding" if "message" in _t else "1 - Asking")
            o.update({
                "Cowork Task Category": category,
                "Task Engagement Mode": mode,
                "Task Breakdown Category": category,
                "Task Breakdown Group": {"Email workflows": "Email", "Analysis & Research": "Data & Analysis",
                                         "Document & content creation": "Document Creation",
                                         "Communication workflows": "Collaboration & Workflows"}
                .get(category, "General Chat & Q&A"),
            })
        else:
            o.update({
                "Cowork Task Category": None,
                "Task Engagement Mode": r["Usage_Mode"],
                "Task Breakdown Category": r["Behavior_Enriched_Full"],
                "Task Breakdown Group": groups.get(ci(r["Behavior_Enriched_Full"])),
            })
    return out


class TemplateLookupTests(unittest.TestCase):
    def test_validation_handoff_uses_actual_notebook_derivation(self):
        spec = importlib.util.spec_from_file_location(
            "slimming_validation", ROOT / "scripts" / "Validate-Model-Slimming.py")
        validation = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validation)
        self.assertEqual(list(validation.SOURCES), processor.SLIM_COLS)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            validation.emit(destination)
            manifest = json.loads((destination / "column-manifest.json").read_text())
            self.assertFalse(manifest["writes"])
            self.assertEqual(len(manifest["columns"]), 26)
            self.assertEqual(len(list((destination / "dax").glob("*.dax"))), 25)
            code = (destination / "spark_slimming.py").read_text()
            compile(code, "spark_slimming.py", "exec")
            self.assertIn("def slim_model_columns(fact):", code)
            self.assertIn("def build_candidate(source):", code)
            self.assertIn("collision", code)

    def test_behavior_group_matches_both_templates(self):
        for path in TEMPLATES:
            with self.subTest(template=path.name):
                groups, bvm, hte = template_behavior_groups(path)
                self.assertGreater(len(bvm), 40)
                self.assertGreater(len(hte), 40)
                self.assertNotIn("behavior", groups)  # header row skipped
                self.assertEqual(len({r["Behavior"].lower() for r in bvm}), len(bvm),
                                 "'Behavior Value Map'[Behavior] must stay unique (many-to-one key)")
                self.assertEqual(groups, processor.BEHAVIOR_GROUP,
                                 "update BEHAVIOR_GROUP in the processor and notebook to match the template")

    def test_notebook_constants_match_processor(self):
        self.assertEqual(notebook_constant("BEHAVIOR_GROUP"), processor.BEHAVIOR_GROUP)
        self.assertEqual(notebook_constant("MATERIAL_TYPES"), processor.MATERIAL_TYPES)
        self.assertEqual(notebook_constant("SLIM_COLS"), processor.SLIM_COLS)
        self.assertEqual(set(processor.MATERIAL_TYPES), DAX_MATERIAL)

    def test_slim_columns_are_enriched_output(self):
        self.assertEqual(len(processor.SLIM_COLS), 26)
        self.assertEqual(processor.ENRICHED_COLS[-26:], processor.SLIM_COLS)


class DaxReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.groups = template_behavior_groups(TEMPLATES[0])[0]

    def test_goldens_match_dax_reference(self):
        checked = 0
        for path in sorted(GOLDEN.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            names = [c[0] for c in data["columns"]]
            if "Thread_Key" not in names:
                continue
            rows = [dict(zip(names, r)) for r in data["rows"]]
            for i, (row, ref) in enumerate(zip(rows, reference(rows, self.groups))):
                for column in processor.SLIM_COLS:
                    with self.subTest(golden=path.name, row=i, column=column):
                        self.assertEqual(row[column], ref[column])
            checked += len(rows)
        self.assertGreater(checked, 300)

    def test_goldens_cover_every_branch(self):
        data = json.loads((GOLDEN / "modern_keep_agents.json").read_text(encoding="utf-8"))
        names = [c[0] for c in data["columns"]]
        seen = {c: {r[names.index(c)] for r in data["rows"]} for c in processor.SLIM_COLS}
        self.assertEqual(seen["Agent Filter (Normalized)"], {"Copilot", "Agents", "Cowork"})
        self.assertEqual(seen["Session Turn Band"], {"Not recorded", "1 turn", "2-3 turns", "4-6 turns", "7+ turns"})
        self.assertEqual(seen["Work Shape"], {"Cross-app chain", "Builds an artifact", "Multi-source synthesis",
                                              "Chat only", "Single-app task", "Read messages", "Not enough detail"})
        self.assertEqual(seen["Model Cost Tier"], {"Not attributed", "Frontier (premium cost)",
                                                   "Workhorse (mid cost)", "Unclassified"})
        self.assertEqual(seen["Cowork Task Category"] - {None}, {
            "Email workflows", "Analysis & Research", "Document & content creation", "Communication workflows",
            "General assistance / Other"})
        self.assertTrue({"1 - Asking", "2 - Finding", "3 - Consuming", "4 - Producing"} <= seen["Task Engagement Mode"])
        self.assertIn(None, seen["Thread_Key"])

    def test_keys_count_like_the_id_text(self):
        # DISTINCTCOUNT / SUMMARIZE / VALUES over the key see the same groups as over the id text.
        for path in sorted(GOLDEN.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            names = [c[0] for c in data["columns"]]
            if "Thread_Key" not in names:
                continue
            for text_col, key_col in (("ThreadId", "Thread_Key"), ("Message_Id", "Message_Key")):
                pairs = {(ci(r[names.index(text_col)]), r[names.index(key_col)]) for r in data["rows"]}
                with self.subTest(golden=path.name, column=key_col):
                    self.assertEqual(len(pairs), len({t for t, _ in pairs}))
                    self.assertEqual(len(pairs), len({k for _, k in pairs}))
                    self.assertTrue(all((t is None) == (k is None) for t, k in pairs))


# --- the shipped models --------------------------------------------------------------------------
def load_slimmer():
    spec = importlib.util.spec_from_file_location("model_slimming", ROOT / "scripts" / "Update-Model-Slimming.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def dax_text(value):
    return "\n".join(value) if isinstance(value, list) else (value or "")


class ShippedModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.slim = load_slimmer()
        cls.models = {}
        for path in TEMPLATES:
            with zipfile.ZipFile(path) as archive:
                cls.models[path.name] = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]

    def fact(self, model):
        return next(t for t in model["tables"] if t["name"] == self.slim.AUDIT)

    def test_templates_are_current_and_the_patch_is_idempotent(self):
        for path in TEMPLATES:
            with self.subTest(template=path.name):
                original = path.read_bytes()
                rebuilt, changed = self.slim.build(original)
                self.assertEqual(changed, [], "stale: run scripts/Update-Model-Slimming.py")
                self.assertEqual(rebuilt, original)

    def test_patch_lists_match_the_processor(self):
        self.assertEqual([n for n, _ in self.slim.SLIM_COLUMNS] + list(self.slim.KEYS.values()), processor.SLIM_COLS)
        self.assertTrue(set(self.slim.HELPER_COLUMNS).isdisjoint(processor.SLIM_COLS))

    def test_fact_table_has_no_calculated_columns(self):
        for name, model in self.models.items():
            with self.subTest(template=name):
                columns = {c["name"]: c for c in self.fact(model)["columns"]}
                self.assertEqual([c for c, v in columns.items() if v.get("type") == "calculated"], [])
                for column, data_type in self.slim.SLIM_COLUMNS:
                    self.assertEqual(columns[column]["sourceColumn"], column)
                    self.assertEqual(columns[column]["dataType"], data_type)
                for column in list(self.slim.HELPER_COLUMNS) + ["CreationDate"]:
                    self.assertNotIn(column, columns)
                for column in columns.values():
                    if column.get("sortByColumn"):
                        self.assertIn(column["sortByColumn"], columns)

    def test_id_columns_keep_their_names_but_import_integer_keys(self):
        for name, model in self.models.items():
            for column, key in (("ThreadId", "Thread_Key"), ("Message_Id", "Message_Key")):
                with self.subTest(template=name, column=column):
                    record = next(c for c in self.fact(model)["columns"] if c["name"] == column)
                    self.assertEqual(record["sourceColumn"], key)
                    self.assertEqual(record["dataType"], "int64")
                    self.assertTrue(record["isHidden"])
                    self.assertEqual(record["summarizeBy"], "none")

    def test_fact_query_drops_ids_and_null_guards_processed_columns(self):
        for name, model in self.models.items():
            with self.subTest(template=name):
                fact = self.fact(model)
                partition = dax_text(fact["partitions"][0]["source"]["expression"])
                self.assertEqual(partition, dax_text(fact["refreshPolicy"]["sourceExpression"]))
                self.assertIn('[CreationDate] >= RangeStart and [CreationDate] < RangeEnd', partition)
                removed = re.search(r"Table\.RemoveColumns\(Filtered, \{(.*?)\}", partition).group(1)
                for column in self.slim.TRIMMED:
                    self.assertIn(f'"{column}"', removed)
                for column in ("ThreadId", "Message_Id", "CreationDate", "AccessedResource_SiteUrl"):
                    self.assertIn(f'"{column}"', removed)
                for column in processor.SLIM_COLS:
                    self.assertIn(f'{{"{column}", ', partition)
                self.assertIn("Table.AddColumn(t, c{0}, each null, c{1})", partition)

    def test_no_dax_reads_creation_date(self):
        ref = re.compile(re.escape(f"'{self.slim.AUDIT}'[CreationDate]"), re.IGNORECASE)
        for name, model in self.models.items():
            for table in model["tables"]:
                objects = table.get("measures", []) + table.get("columns", [])
                objects += [p["source"] for p in table.get("partitions", []) if p["source"].get("type") == "calculated"]
                for item in objects:
                    with self.subTest(template=name, table=table["name"], item=item.get("name")):
                        self.assertIsNone(ref.search(dax_text(item.get("expression"))))


if __name__ == "__main__":
    unittest.main()
