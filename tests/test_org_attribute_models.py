"""Replay the shipped row-builder M and verify safe, reproducible template updates."""
import copy
from datetime import date, datetime, time
import importlib.util
import io
import json
from pathlib import Path
import re
import unittest
import zipfile

from m_eval import evaluate

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("org_attributes", ROOT / "scripts" / "Update-Org-Attributes.py")
UPDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATE)


class Table(list):
    def __init__(self, rows=(), kinds=None):
        super().__init__(rows)
        self.kinds = kinds or {key: "text" for row in rows for key in row}


def distinct(items, comparer=None):
    out, seen = [], set()
    for item in items:
        key = item.casefold() if comparer else item
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def text(value, culture=None):
    if value is None:
        return None
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (dict, list)):
        raise ValueError("Non-scalar source attribute")
    return str(value)


def add_column(table, name, fn, column_type=None):
    return Table([{**row, name: fn(row)} for row in table], {**table.kinds, name: "text"})


def build_rows(rows, kinds=None, key="PersonId_Normalized"):
    # Desugar only M type literals / #table / each-field shorthand. Execute the
    # actual shipped expression; table functions retain null rows and source types.
    code = UPDATE.ROWS_M.replace("#table", "Table.Empty").replace("[Name]", "_[Name]")
    code = re.sub(r"\btype (datetimezone|datetime|date|time|text)\b", r"Type.\1", code)
    env = {
        "Table.Buffer": lambda table: table,
        "Table.Schema": lambda table: [{"Name": c, "Kind": k} for c, k in table.kinds.items()],
        "Table.ColumnNames": lambda table: list(table.kinds),
        "Table.Column": lambda table, col: [row.get(col) for row in table],
        "Table.SelectRows": lambda table, fn: [row for row in table if fn(row)],
        "Table.FromColumns": lambda columns, names: Table([dict(zip(names, row)) for row in zip(*columns)]),
        "Table.AddColumn": add_column,
        "Table.Empty": lambda names, rows: Table([dict(zip(names, row)) for row in rows], dict.fromkeys(names, "text")),
        "Table.Combine": lambda tables: Table([row for table in tables for row in table]),
        "Table.TransformColumnTypes": lambda table, types: table,
        "List.RemoveItems": lambda items, removed: [x for x in items if x not in removed],
        "List.Count": len,
        "List.IsEmpty": lambda items: not items,
        "List.Distinct": distinct,
        "Comparer.OrdinalIgnoreCase": "ignore-case",
        "Text.From": text,
        "Value.Is": lambda v, kind: type(v) is kind,
        "Type.datetimezone": "datetimezone",
        "Type.datetime": datetime,
        "Type.date": date,
        "Type.time": time,
        "Type.text": str,
        "DateTimeZone.ToText": lambda v, fmt: v.isoformat(),
        "DateTime.ToText": lambda v, fmt: v.isoformat(),
        "Date.ToText": lambda v, fmt: v.isoformat(),
        "Time.ToText": lambda v, fmt: v.isoformat(),
    }
    return evaluate(code, env)(Table(rows, kinds), key)


class OrgAttributeRowsTests(unittest.TestCase):
    def test_new_arbitrary_fields_appear_on_next_refresh_without_new_columns(self):
        first = [{"PersonId_Normalized": f"p{i}", "Organization": "Org"} for i in range(1000)]
        self.assertEqual(build_rows(first), [])
        later = copy.deepcopy(first)
        later[0].update({"BusinessUnitId": "A", 'Odd "] field': "North"})
        later[1].update({"BusinessUnitId": "B", 'Odd "] field': "South"})
        rows = build_rows(later)
        self.assertEqual({r["Attribute"] for r in rows}, {"BusinessUnitId", 'Odd "] field'})
        self.assertEqual(len(rows), 2002)
        self.assertEqual(sum(r["Value"] is None for r in rows), 1998)
        self.assertEqual({r["PersonId_Normalized"] for r in rows}, {None} | {f"p{i}" for i in range(1000)})

    def test_scalar_types_and_high_cardinality_are_not_dropped(self):
        source = [{"PersonId_Normalized": f"p{i}", "Budget": i, "Enabled": bool(i % 2),
                   "Since": date(2026, 1, i + 1), "Value": str(i), "Attribute": f"code-{i}"}
                  for i in range(20)]
        kinds = {"PersonId_Normalized": "text", "Budget": "number", "Enabled": "logical",
                 "Since": "date", "Value": "text", "Attribute": "text"}
        rows = build_rows(source, kinds)
        self.assertEqual(len(rows), 105)
        self.assertEqual({r["ValueType"] for r in rows}, {"string", "number", "boolean", "date"})
        self.assertIn({"PersonId_Normalized": "p0", "Value": "false", "Attribute": "Enabled",
                       "ValueType": "boolean"}, rows)
        self.assertEqual(next(r["Value"] for r in rows if r["Attribute"] == "Since"), "2026-01-01")

    def test_blank_plus_one_value_is_not_meaningful(self):
        rows = build_rows([{"PersonId_Normalized": str(i), "Single": v, "Blank": None}
                           for i, v in enumerate([None, "", " ", "One", "ONE "])])
        self.assertEqual(rows, [])

    def test_evaluator_join_key_and_source_column_name_collisions(self):
        rows = build_rows([{"Org Join Key": "p1", "PersonId_Normalized": "one", "Value": "A"},
                           {"Org Join Key": "p2", "PersonId_Normalized": "two", "Value": "B"}],
                          key="Org Join Key")
        self.assertEqual(len(rows), 3)
        self.assertEqual({r["PersonId_Normalized"] for r in rows}, {"p1", "p2", None})
        self.assertEqual({r["Attribute"] for r in rows}, {"Value"})

    def test_lean_identity_fields_are_excluded_but_raw_account_enabled_is_available(self):
        source = [
            {"PersonId_Normalized": f"p{i}", "accountEnabled": bool(i),
             **{c: f"{c}-{i}" for c in UPDATE.EXCLUDED if c != "PersonId_Normalized"}}
            for i in range(2)
        ]
        rows = build_rows(source, {**dict.fromkeys(source[0], "text"), "accountEnabled": "logical"})
        self.assertEqual({r["Attribute"] for r in rows}, {"accountEnabled"})
        self.assertEqual({r["Value"] for r in rows}, {"true", "false", None})
        self.assertEqual({r["ValueType"] for r in rows}, {"boolean"})

    def test_non_scalar_is_an_explicit_failure(self):
        with self.assertRaisesRegex(ValueError, "Non-scalar"):
            build_rows([{"PersonId_Normalized": "p1", "Unexpected": {"nested": "value"}}])

    def test_consumption_accepts_sparse_fields_but_not_blank_plus_constant(self):
        source = [{"Rare": None, "Single": None} for _ in range(1000)]
        source[0] = {"Rare": "North", "Single": "Only"}
        source[1]["Rare"] = "South"
        function = "(Base as table) => let\n" + UPDATE.CREDIT_LIVE.strip() + "\nin Live"
        # CREDIT_LIVE is a let binding prefix, so remove its final comma.
        function = function.replace(">= 2),\nin", ">= 2)\nin")
        live = evaluate(function, {
            "Attrs": ["Rare", "Single"],
            "Blank": lambda v: v is None or not str(v).strip(),
            "Table.Column": lambda table, col: [row[col] for row in table],
            "List.Count": len, "List.Distinct": distinct,
            "Comparer.OrdinalIgnoreCase": "ignore-case", "Text.From": text,
        })(source)
        self.assertEqual(live, ["Rare"])

    def test_consumption_pretty_label_collisions_retain_distinct_source_names(self):
        code = UPDATE.CREDIT_PRETTY.strip().removesuffix(",")
        fn = evaluate("let " + code + " in Pretty", {
            "Live": ["BusinessUnit", "Business Unit", "Department"],
            "RawPretty": lambda c: "Business Unit" if c in ("BusinessUnit", "Business Unit") else c,
            "List.Count": len,
        })
        self.assertEqual(fn("BusinessUnit"), "BusinessUnit")
        self.assertEqual(fn("Business Unit"), "Business Unit")
        self.assertEqual(fn("Department"), "Department")


class OrgAttributeTemplatesTests(unittest.TestCase):
    def test_shipped_templates_are_current_and_byte_idempotent(self):
        for path in UPDATE.TEMPLATES:
            with self.subTest(path=path):
                original = (ROOT / path).read_bytes()
                rebuilt, changes = UPDATE.build(original)
                self.assertEqual(changes, [])
                self.assertEqual(rebuilt, original)

    def test_bridge_preserves_existing_model_objects_and_security(self):
        original = {"model": {
            "tables": [{"name": UPDATE.ORG, "columns": [{"name": "Calculated", "type": "calculated",
                       "expression": '"unchanged"'}], "partitions": [{"source": {"type": "m",
                       "expression": 'let Result = FabricTable("copilot_org_data") in Result'}}]}],
            "relationships": [{"name": "existing", "fromTable": "Fact", "toTable": UPDATE.ORG}],
            "roles": [{"name": "Scoped", "tablePermissions": [{"name": UPDATE.ORG,
                       "filterExpression": "[Organization] = \"Allowed\""}]}],
        }}
        before = copy.deepcopy(original)
        UPDATE.edit_model(original)
        model = original["model"]
        self.assertEqual(model["roles"], before["model"]["roles"])
        self.assertEqual(model["tables"][0], before["model"]["tables"][0])
        self.assertEqual(model["relationships"][0], before["model"]["relationships"][0])
        self.assertFalse(UPDATE.edit_model(original))
        rel = model["relationships"][-1]
        self.assertEqual(rel["crossFilteringBehavior"], "bothDirections")
        self.assertEqual(rel["securityFilteringBehavior"], "oneDirection")
        self.assertEqual(rel["fromTable"], UPDATE.BRIDGE)
        self.assertEqual(rel["toTable"], UPDATE.ORG)

    def test_previous_single_direction_bridge_is_upgraded_without_changing_security(self):
        path = ROOT / UPDATE.TEMPLATES[0]
        with zipfile.ZipFile(path) as archive:
            model = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))
        relation = next(r for r in model["model"]["relationships"] if r["fromTable"] == UPDATE.BRIDGE)
        relation["crossFilteringBehavior"] = "oneDirection"
        before = copy.deepcopy(model["model"]["relationships"])
        UPDATE.edit_model(model)
        self.assertEqual(relation["crossFilteringBehavior"], "bothDirections")
        self.assertEqual(relation["securityFilteringBehavior"], "oneDirection")
        before[-1]["crossFilteringBehavior"] = "bothDirections"
        self.assertEqual(before, model["model"]["relationships"])

    def test_bridge_with_an_extra_relationship_is_rejected_as_ambiguous(self):
        with zipfile.ZipFile(ROOT / UPDATE.TEMPLATES[0]) as archive:
            model = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))
        model["model"]["relationships"].append({
            "name": "another-path", "fromTable": UPDATE.BRIDGE, "toTable": "Fact",
            "fromColumn": "PersonId_Normalized", "toColumn": "PersonId",
        })
        with self.assertRaisesRegex(ValueError, "ambiguous filter paths"):
            UPDATE.edit_model(model)

    def test_denominators_clear_bridge_value_without_clearing_selected_attribute(self):
        cases = {
            "Licensed Users (Filter-Aware)": "REMOVEFILTERS('Chat + Agent Org Data')",
            "Org Credit Share %": "ALL('Chat + Agent Org Data')",
        }
        for name, old in cases.items():
            with self.subTest(measure=name):
                measure = {"name": name, "expression": f"CALCULATE([Metric], {old})",
                           "formatString": "0.0%", "lineageTag": "stable"}
                model = {"tables": [{"name": "Measures", "measures": [measure]}]}
                UPDATE.bridge_denominators(model)
                self.assertIn("REMOVEFILTERS('Org Attribute Source'[Value])", measure["expression"])
                self.assertNotIn("REMOVEFILTERS('Org Attribute Source')", measure["expression"])
                self.assertNotIn("'Org Attribute Source'[Attribute]", measure["expression"])
                self.assertEqual(measure["lineageTag"], "stable")
                self.assertEqual(measure["formatString"], "0.0%")
                before = copy.deepcopy(model)
                UPDATE.bridge_denominators(model)
                self.assertEqual(model, before)

    def test_sparse_group_memberships_preserve_full_denominator(self):
        source = [{"PersonId_Normalized": f"p{i}", "Organization": "Org",
                   "Sparse": "A" if i == 0 else "B" if i == 1 else None}
                  for i in range(1000)]
        rows = build_rows(source)
        facts = {f"p{i}": i + 1 for i in range(1000)}
        # Relationship unknown member represents fact users absent from org.
        facts[None] = 1234
        grouped = {}
        for membership in rows:
            grouped.setdefault(membership["Value"], []).append(membership["PersonId_Normalized"])
        totals = {value: sum(facts[key] for key in keys) for value, keys in grouped.items()}
        full = sum(facts.values())
        self.assertEqual(totals, {"A": 1, "B": 2, None: full - 3})
        self.assertEqual(sum(totals.values()), full)
        # Model denominator drops Value, retains Sparse's Attribute inventory.
        denominator = sum(facts[r["PersonId_Normalized"]] for r in rows if r["Attribute"] == "Sparse")
        self.assertEqual(denominator, full)
        self.assertAlmostEqual(sum(value / denominator for value in totals.values()), 1)

    def test_expanded_fact_resets_clear_bridge_group_filters(self):
        names = {
            "Efficiency - Hours Per User Per Week", "Expert Equivalent Hours Per Week",
            "Work Created - Per Week", "Last Full Month Start",
            "Cowork Fit: Surfaces Per Active Day", "Cowork Fit: Eligible Users",
            "Cowork Fit: Session Depth", "Cowork Fit: Agent User Share", "License Evidence Notice",
        }
        for path in UPDATE.TEMPLATES[:2]:
            with zipfile.ZipFile(ROOT / path) as archive:
                document = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))
            measures = {m["name"]: UPDATE.ZIP.joined(m["expression"])
                        for t in document["model"]["tables"] for m in t.get("measures", [])}
            for name in names:
                self.assertIn("REMOVEFILTERS('Org Attribute Source'[Value])", measures[name], name)
                self.assertNotIn("REMOVEFILTERS('Org Attribute Source')", measures[name], name)
            before = copy.deepcopy(document)
            UPDATE.bridge_denominators(document["model"])
            self.assertEqual(document, before)

    def test_zip_non_owned_members_and_metadata_are_preserved(self):
        # Remove the bridge to exercise an actual rebuild, not just the no-op path.
        original = (ROOT / UPDATE.TEMPLATES[0]).read_bytes()
        infos, payloads, comment = UPDATE.ZIP.read_archive(original)
        model, encode = UPDATE.ZIP.codec(payloads["DataModelSchema"], "DataModelSchema")
        model["model"]["tables"] = [t for t in model["model"]["tables"] if t["name"] != UPDATE.BRIDGE]
        model["model"]["relationships"] = [r for r in model["model"]["relationships"]
                                           if r["fromTable"] != UPDATE.BRIDGE]
        payloads["DataModelSchema"] = encode(model)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.comment = comment
            for info in infos:
                archive.writestr(copy.copy(info), payloads[info.filename])
        rebuilt, changes = UPDATE.build(buffer.getvalue())
        self.assertEqual(changes, ["DataModelSchema"])
        after_infos, after, after_comment = UPDATE.ZIP.read_archive(rebuilt)
        self.assertEqual(comment, after_comment)
        for old, new in zip(infos, after_infos):
            for key in UPDATE.ZIP.ZIP_METADATA:
                self.assertEqual(getattr(old, key), getattr(new, key))
            if old.filename != "DataModelSchema":
                self.assertEqual(payloads[old.filename], after[old.filename])

    def test_bridge_reads_full_source_before_lean_projection(self):
        for path in UPDATE.TEMPLATES[:3]:
            with zipfile.ZipFile(ROOT / path) as archive:
                model = json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))["model"]
            bridge = next(t for t in model["tables"] if t["name"] == UPDATE.BRIDGE)
            query = "\n".join(bridge["partitions"][0]["source"]["expression"])
            self.assertIn('FabricTable("copilot_org_data")', query)
            self.assertNotIn("__lean", query)
            self.assertNotIn("each Table.RowCount", query)
            self.assertIn("Table.ColumnNames(Base)", query)
            self.assertIn("DistinctPopulated(_) >= 2", query)


if __name__ == "__main__":
    unittest.main()
