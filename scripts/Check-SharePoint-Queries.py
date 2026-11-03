"""Report which of the app's ValueLens queries the vendored SharePoint model can answer.

The app reads ValueLens from the model the installer builds from ValueLens - Fabric.pbit. A
SharePoint setup would read it from the model in sharepoint/ instead, copied unchanged from the
ValueLens repository. This reads every .dax query the app sends to the ValueLens connection
("vl" in app/src/queries/shared.ts), and the filter bar's columns, and lists each table, column
and measure that model lacks, with where AH gets it today: AH's Fabric template, the installer,
or neither.

It only reports. It changes nothing and always exits 0. It checks names, not DAX: a query
"resolves" when every table, column and measure it names is in the model. In DAX written in .ts
files only 'Table'[Column] names are checked, and names the app fills in at run time are listed,
not checked. Consumption Central and Agent Evaluator queries aren't checked, because sharepoint/
has no model for them.

    python scripts/Check-SharePoint-Queries.py          # a summary
    python scripts/Check-SharePoint-Queries.py --json   # every query and name, as JSON
"""
import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = Path("sharepoint") / "ValueLens - SharePoint.pbit"
PROVENANCE = Path("sharepoint") / "provenance.json"
FABRIC = Path("fabric") / "ValueLens - Fabric.pbit"
QUERIES = Path("app") / "src" / "queries"
SHARED = QUERIES / "shared.ts"
FILTERS = Path("app") / "src" / "lib" / "filters.ts"
ORG_ATTRIBUTE = Path("app") / "src" / "lib" / "org-attribute.ts"
INSTALLER = Path("installer") / "src"
CHECKED = "vl"
NOT_CHECKED = {
    "cc": "Consumption Central queries: sharepoint/ has no Consumption Central model yet",
    "ae": "Agent Evaluator queries: a SharePoint setup has no Agent Evaluator model",
}
NOT_APP_CODE = (".spec.ts", ".test.ts", ".fixture.ts", ".d.ts")

TOKEN = re.compile(
    r"(?P<comment>//[^\n]*|--[^\n]*|/\*.*?\*/)"
    r"|(?P<string>\"(?:[^\"]|\"\")*\")"
    r"|(?P<table>'(?:[^']|'')*')"
    r"|(?P<bracket>\[(?:[^\]]|\]\])*\])"
    r"|(?P<word>[^\W\d][\w.]*)"
    r"|(?P<space>\s+)"
    r"|(?P<other>.)",
    re.S,
)
# Words that can stand right before a bracket without naming its table.
KEYWORDS = {"and", "asc", "at", "by", "column", "define", "desc", "evaluate", "false", "function", "in",
            "measure", "not", "or", "order", "return", "start", "table", "true", "var"}
# Columns DAX makes itself: {…} and GENERATESERIES give [Value] or [Value1]…, CALENDAR gives [Date].
BUILT_IN = re.compile(r"value\d*|date")
# Columns some DAX functions return, by function.
FUNCTION_COLUMNS = {
    "columnstatistics": {"table name", "column name", "min", "max", "cardinality", "max length"},
}
# Names the app replaces before it sends a query, such as [__USERS__].
RUN_TIME = re.compile(r"__\w+__")

SHARED_IMPORT = re.compile(r"import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*[\"'][^\"']*/shared[\"']")
DAX_IMPORT = re.compile(r"import\s+([A-Za-z_$][\w$]*)\s+from\s+[\"']([^\"']+\.dax)\?raw[\"']")
IMPORT_STATEMENT = re.compile(r"^\s*import\b[^;]*;", re.M)
LOCAL_IMPORT = re.compile(r"^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*[\"'](\.\.?/[^\"']+)[\"']", re.M)
EXPORTED_CONNECTION = re.compile(r"export\s+const\s+(\w*[cC]onnection)\s*=\s*\"([^\"]+)\"")
CONNECTION_PROPERTY = re.compile(r"(?<![\w$.])connection\b\s*(?::\s*([A-Za-z_$][\w$]*))?")
DAX_IN_CODE = re.compile(r"'[^'\n]+'\[[^\]\n]+\]|\b(?:EVALUATE|SUMMARIZECOLUMNS|CALCULATETABLE)\b")
CODE_REFERENCE = re.compile(r"'(?:[^'\n]|'')+'\[[^\]\n]+\]")


def read_text(path):
    return path.read_text(encoding="utf-8")


def strip_comments(source):
    return re.sub(r"(?m)^\s*//.*$", "", re.sub(r"/\*.*?\*/", "", source, flags=re.S))


def load_model(path):
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read("DataModelSchema").decode("utf-16-le").lstrip("\ufeff"))["model"]


def catalog(model):
    """Every table, column and measure in a model, by casefolded name."""
    tables, measures, columns = {}, {}, set()
    for table in model.get("tables", []):
        names = {c["name"].casefold() for c in table.get("columns", []) if c.get("type") != "rowNumber"}
        own = {m["name"].casefold() for m in table.get("measures", [])}
        tables[table["name"].casefold()] = {"name": table["name"], "columns": names, "measures": own}
        measures.update((m, table["name"]) for m in own)
        columns |= names
    return {"tables": tables, "measures": measures, "columns": columns}


class Query:
    """The names one DAX query uses, and the ones it defines for itself."""

    def __init__(self, dax):
        self.refs = []          # (table or None, column or None), as written
        self.names = set()      # VAR, TABLE and FUNCTION names
        self.defined = {}       # table: columns and measures DEFINE adds to it
        self.strings = set()    # every string literal: it may name a column the query adds
        self.made = set()       # columns the functions it calls return, such as COLUMNSTATISTICS()'s
        tokens = [(m.lastgroup, m.group()) for m in TOKEN.finditer(dax) if m.lastgroup != "comment"]
        i = 0
        while i < len(tokens):
            kind, text = tokens[i]
            if kind == "string":
                self.strings.add(text[1:-1].replace('""', '"').casefold())
            elif kind == "word" and text.casefold() in ("measure", "column"):
                j = self._next(tokens, i + 1)
                ref, end = self._column(tokens, j)
                if ref and ref[1] is not None:
                    self.defined.setdefault(ref[0].casefold(), set()).add(ref[1].casefold())
                    self.refs.append((ref[0], None))
                    i = end
            elif kind == "word" and text.casefold() in ("var", "table", "function"):
                j = self._next(tokens, i + 1)
                if j < len(tokens) and tokens[j][0] in ("word", "table"):
                    name = tokens[j][1]
                    self.names.add((name[1:-1].replace("''", "'") if tokens[j][0] == "table" else name).casefold())
                    i = j
            elif kind in ("word", "table"):
                if kind == "word":
                    self.made |= FUNCTION_COLUMNS.get(text.casefold(), set())
                ref, end = self._column(tokens, i)
                if ref:
                    self.refs.append(ref)
                    i = end
            elif kind == "bracket":
                self.refs.append((None, text[1:-1].replace("]]", "]")))
            i += 1

    @staticmethod
    def _next(tokens, i):
        while i < len(tokens) and tokens[i][0] == "space":
            i += 1
        return i

    def _column(self, tokens, i):
        """('T', 'X') for 'T'[X] or T[X] at i, ('T', None) for a lone 'T', and the last token used."""
        if i >= len(tokens):
            return None, i
        kind, text = tokens[i]
        if kind == "table":
            j = self._next(tokens, i + 1)
            table = text[1:-1].replace("''", "'")
            if j < len(tokens) and tokens[j][0] == "bracket":
                return (table, tokens[j][1][1:-1].replace("]]", "]")), j
            return (table, None), i
        if kind == "word" and text.casefold() not in KEYWORDS and i + 1 < len(tokens) and tokens[i + 1][0] == "bracket":
            return (text, tokens[i + 1][1][1:-1].replace("]]", "]")), i + 1
        return None, i


def problem(table, column, model, query):
    """Why a model can't answer one name a query uses, or None when it can."""
    if table is not None:
        key = table.casefold()
        if key in query.names:
            return None
        entry = model["tables"].get(key)
        if entry is None:
            return "no such table"
        if column is None:
            return None
        name = column.casefold()
        if name in entry["columns"] or name in entry["measures"] or name in query.defined.get(key, ()):
            return None
        home = model["measures"].get(name)
        return f"a measure on '{home}'" if home else "no such column"
    name = column.casefold()
    if (name in model["measures"] or name in model["columns"] or name in query.names or name in query.strings
            or name in query.made or BUILT_IN.fullmatch(name)
            or any(name in names for names in query.defined.values())):
        return None
    return "no such measure"


def installer_sources(root):
    folder = root / INSTALLER
    if not folder.is_dir():
        return []
    paths = sorted(folder.rglob("*.js"), key=lambda p: (p.parent.name != "transform", p.as_posix()))
    return [(p.relative_to(root).as_posix(), p.read_text(encoding="utf-8", errors="replace")) for p in paths]


def origin(table, column, why, query, fabric, installer):
    """Where AH gets a name the SharePoint model lacks."""
    if fabric is not None and problem(table, column, fabric, query) is None:
        return "in AH's Fabric template"
    name = table if why == "no such table" else column
    # The file that defines it, as name: 'X' or X_TABLE = 'X', says more than one that only lists it.
    defines = re.compile(r"(?:\bname\s*:|(?<![=!<>])=)\s*(['\"`])" + re.escape(name) + r"\1")
    for path, text in installer:
        if defines.search(text):
            return f"added by {path}"
    quoted = (f"'{name}'", f'"{name}"', f"`{name}`", f"[{name}]")
    for path, text in installer:
        if any(q in text for q in quoted):
            return f"named in {path}"
    return "in neither AH's Fabric template nor the installer"


def written(table, column):
    if table is None:
        return f"[{column}]"
    quoted = "'" + table.replace("'", "''") + "'"
    return quoted if column is None else f"{quoted}[{column}]"


def check(dax, model, fabric, installer):
    """The names a query uses that the model lacks, and the names filled in at run time."""
    query = Query(dax)
    missing, run_time = {}, set()
    for table, column in query.refs:
        late = [n for n in (table, column) if n is not None and RUN_TIME.fullmatch(n)]
        if late:
            run_time.update(late)
            continue
        why = problem(table, column, model, query)
        if not why:
            continue
        # A missing table is one gap, however many of its columns the query uses.
        whole = why == "no such table"
        name = written(table, None if whole else column)
        key = name.casefold()
        if key not in missing:
            missing[key] = {"name": name, "problem": why,
                            "origin": origin(table, None if whole else column, why, query, fabric, installer)}
            if whole:
                missing[key]["columns"] = []
        if whole and column is not None and column not in missing[key]["columns"]:
            missing[key]["columns"].append(column)
    for entry in missing.values():
        entry.get("columns", []).sort(key=str.casefold)
    return [missing[k] for k in sorted(missing)], sorted(run_time)


def connections_in(source, exported):
    """{local name: connection} for the connections a module imports from shared.ts."""
    names = {}
    for block in SHARED_IMPORT.findall(source):
        for item in block.split(","):
            item = item.strip()
            if not item or item.startswith("type "):
                continue
            original, _, local = item.partition(" as ")
            if original.strip() in exported:
                names[(local or original).strip()] = exported[original.strip()]
    return names


def enclosing_object(source, index):
    """The text inside the innermost { … } around index, or None."""
    depth = 0
    for start in range(index - 1, -1, -1):
        if source[start] == "}":
            depth += 1
        elif source[start] == "{":
            if depth == 0:
                break
            depth -= 1
    else:
        return None
    depth = 0
    for end in range(index, len(source)):
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            if depth == 0:
                return source[start + 1:end]
            depth -= 1
    return None


def object_connection(source, index, local):
    """The connection of the object literal a query is passed in, or None."""
    text = enclosing_object(source, index)
    if text is None:
        return None
    previous = None
    while previous != text:
        previous, text = text, re.sub(r"\{[^{}]*\}", "", text)
    match = CONNECTION_PROPERTY.search(text)
    return local.get(match.group(1) or "connection") if match else None


def local_imports(module, source):
    """The app modules a module imports values from or re-exports; type-only imports don't count."""
    found = set()
    for spec in LOCAL_IMPORT.findall(source):
        base = module.parent / spec
        for candidate in (base, base.with_name(base.name + ".ts"), base / "index.ts"):
            if candidate.suffix == ".ts" and candidate.is_file():
                found.add(candidate.resolve())
                break
    return found


def attribute(root):
    """{.dax path: set of connections the app sends it to} and the modules that write DAX in code."""
    folder = root / QUERIES
    shared = root / SHARED
    exported = dict(EXPORTED_CONNECTION.findall(read_text(shared))) if shared.is_file() else {}
    modules, importers = {}, {}
    for module in sorted(folder.rglob("*.ts")) if folder.is_dir() else []:
        if module.name.endswith(NOT_APP_CODE):
            continue
        source = strip_comments(read_text(module))
        modules[module.resolve()] = (module, source, connections_in(source, exported))
        for target in local_imports(module, source):
            importers.setdefault(target, set()).add(module.resolve())

    def connections(key, seen=frozenset()):
        """A module's connections or, for one that imports none, those of the modules that import it."""
        own = set(modules[key][2].values())
        if own or key in seen:
            return own
        return set().union(*(connections(k, seen | {key}) for k in sorted(importers.get(key, ())) if k in modules))

    sent, in_code = {}, []
    for key, (module, source, local) in modules.items():
        whole = connections(key)
        body = IMPORT_STATEMENT.sub("", source)
        if DAX_IN_CODE.search(body):
            in_code.append((module.relative_to(root).as_posix(), whole, CODE_REFERENCE.findall(body)))
        for name, target in DAX_IMPORT.findall(source):
            path = (module.parent / target).resolve().relative_to(root.resolve()).as_posix()
            uses = [m.start() for m in re.finditer(rf"(?<![\w$.]){re.escape(name)}(?![\w$])(?!\s*:)", body)]
            found = {c for c in (object_connection(body, i, local) for i in uses) if c}
            sent.setdefault(path, set()).update(found or (whole if len(whole) == 1 else {"?"}))
    return sent, in_code


def filter_columns(root):
    """[(filter, 'T'[X])] for the filter bar: FILTER_COLUMNS, and the org filter's default column."""
    columns = []
    path = root / FILTERS
    if path.is_file():
        text = read_text(path)
        constants = dict(re.findall(r"(?m)^(?:export\s+)?const\s+(\w+)\s*=\s*\"([^\"]*)\"\s*;", text))
        block = re.search(r"FILTER_COLUMNS\s*=\s*\{(.*?)\}\s*as\s+const", text, re.S)
        for key, value in re.findall(r"(\w+)\s*:\s*(\"[^\"]*\"|`[^`]*`)", block.group(1) if block else ""):
            columns.append((key, re.sub(r"\$\{(\w+)\}", lambda m: constants.get(m.group(1), m.group(0)), value[1:-1])))
    path = root / ORG_ATTRIBUTE
    if path.is_file():
        text = read_text(path)
        table = re.search(r"ORG_TABLE\s*=\s*\"([^\"]+)\"", text)
        column = re.search(r"DEFAULT_ORG_ATTRIBUTE\s*=\s*\"([^\"]+)\"", text)
        if table and column:
            columns.append(("organizations", written(table.group(1), column.group(1))))
    return columns


def check_filter(reference, model, fabric, installer):
    refs = Query(reference).refs
    if len(refs) != 1 or refs[0][0] is None or refs[0][1] is None:
        return {"problem": "not a 'Table'[Column] name", "origin": None}
    table, column = refs[0]
    entry = model["tables"].get(table.casefold())
    if entry is None:
        why = "no such table"
    elif column.casefold() in entry["columns"]:
        return None
    else:
        why = "a measure, not a column" if column.casefold() in entry["measures"] else "no such column"
    return {"problem": why, "origin": origin(table, column, why, Query(""), fabric, installer)}


def report(root=ROOT):
    root = Path(root)
    result = {"model": {"file": TEMPLATE.as_posix()}, "problems": [], "filterBar": [], "queries": [],
              "notChecked": {}, "daxInCode": []}
    try:
        model = catalog(load_model(root / TEMPLATE))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as error:
        result["problems"].append(f"Can't read {TEMPLATE.as_posix()}: {error}")
        return result
    try:
        record = json.loads(read_text(root / PROVENANCE))[TEMPLATE.name]
        result["model"].update(repository=record["repository"], commit=record["commit"])
    except (OSError, KeyError, ValueError, TypeError) as error:
        result["problems"].append(f"Can't read the {TEMPLATE.name} record in {PROVENANCE.as_posix()}: {error}")
    result["model"].update(tables=len(model["tables"]), columns=sum(len(t["columns"]) for t in model["tables"].values()),
                           measures=len(model["measures"]))
    try:
        fabric = catalog(load_model(root / FABRIC))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as error:
        fabric = None
        result["problems"].append(f"Can't read {FABRIC.as_posix()}, so origins name only the installer: {error}")
    installer = installer_sources(root)

    for name, reference in filter_columns(root):
        found = check_filter(reference, model, fabric, installer)
        result["filterBar"].append({"filter": name, "column": reference, **(found or {"problem": None, "origin": None})})

    sent, in_code = attribute(root)
    on_disk = {p.relative_to(root).as_posix() for p in (root / QUERIES).rglob("*.dax")} if (root / QUERIES).is_dir() else set()
    for path in sorted(on_disk | set(sent)):
        targets = sent.get(path, set())
        if CHECKED not in targets:
            key = "unused" if not targets else "unknown" if targets == {"?"} else "+".join(sorted(targets - {"?"}))
            result["notChecked"].setdefault(key, []).append(path)
            continue
        try:
            missing, run_time = check(read_text(root / path), model, fabric, installer)
        except OSError as error:
            result["problems"].append(f"Can't read {path}: {error}")
            continue
        parts = Path(path).relative_to(QUERIES).parts
        result["queries"].append({"query": path, "page": parts[0] if len(parts) > 1 else "(top level)",
                                  "connections": sorted(targets), "resolves": not missing,
                                  "missing": missing, "runTime": run_time})
    # DAX written in code isn't parsed; only its 'Table'[Column] names are checked.
    for path, targets, references in in_code:
        if targets and CHECKED not in targets:
            continue
        missing, run_time = check(" ".join(sorted(set(references))), model, fabric, installer)
        parts = Path(path).relative_to(QUERIES).parts
        result["daxInCode"].append({"module": path, "page": parts[0] if len(parts) > 1 else "(top level)",
                                    "connections": sorted(targets), "names": len(set(references)),
                                    "missing": missing, "runTime": run_time})
    return result


def summary(result):
    lines = []
    model = result["model"]
    if "tables" in model:
        source = f", from {model['repository']} {model['commit'][:7]}" if "commit" in model else ""
        lines.append(f"Model: {model['file']}{source}")
        lines.append(f"  {model['tables']} tables, {model['columns']} columns, {model['measures']} measures")
    for message in result["problems"]:
        lines.append(f"Problem: {message}")
    if "tables" not in model:
        return "\n".join(lines)

    bar = result["filterBar"]
    lines.append("")
    lines.append(f"Filter bar columns: {sum(1 for f in bar if not f['problem'])} of {len(bar)} found")
    for entry in bar:
        if entry["problem"]:
            lines.append(f"  {entry['filter']}: {entry['column']}: {entry['problem']}, {entry['origin']}")

    queries = result["queries"]
    lines.append("")
    lines.append(f"ValueLens queries: {sum(q['resolves'] for q in queries)} of {len(queries)} resolve")
    pages = {}
    for query in queries:
        pages.setdefault(query["page"], []).append(query["resolves"])
    width = max((len(p) for p in pages), default=0)
    for page, resolves in sorted(pages.items()):
        lines.append(f"  {page.ljust(width)}  {sum(resolves)} of {len(resolves)}")

    unresolved = [q for q in queries if not q["resolves"]]
    code = result["daxInCode"]
    if unresolved or any(c["missing"] for c in code):
        gaps = {}
        for entry in [*unresolved, *code]:
            for name in entry["missing"]:
                pages = gaps.setdefault(name["name"].casefold(), (name, {}))[1]
                pages[entry["page"]] = pages.get(entry["page"], 0) + 1
        lines.append("")
        lines.append("Missing from the SharePoint model, with where AH gets it today and the queries that use it:")
        for key in sorted(gaps):
            name, pages = gaps[key]
            used = ", ".join(f"{page} {count}" for page, count in sorted(pages.items()))
            lines.append(f"  {name['name']}: {name['problem']}, {name['origin']}. Queries: {used}")

    late = [(q["query"], q["runTime"]) for q in queries if q["runTime"]] + [(c["module"], c["runTime"]) for c in code if c["runTime"]]
    if late or code:
        lines.append("")
        lines.append("Partly checked:")
        for path, run_time in late:
            lines.append(f"  {Path(path).relative_to(QUERIES).as_posix()}: {', '.join(run_time)} filled in at run time")
        if code:
            modules = ", ".join(Path(c["module"]).relative_to(QUERIES).as_posix() for c in code)
            lines.append(f"  DAX written in code, where only 'Table'[Column] names are checked: {modules}")

    if result["notChecked"]:
        lines.append("")
        lines.append("Not checked:")
        for key, paths in sorted(result["notChecked"].items()):
            reason = NOT_CHECKED.get(key) or {
                "unused": "queries no app module imports",
                "unknown": "queries whose connection this can't tell",
            }.get(key, f"queries sent to {key}")
            lines.append(f"  {len(paths)} {reason}")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="print every query and name as JSON")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    result = report(args.root)
    try:
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass
    print(json.dumps(result, indent=2) if args.json else summary(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
