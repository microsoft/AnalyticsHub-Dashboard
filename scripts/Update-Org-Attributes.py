"""Expose arbitrary org attributes as rows, without recurring semantic-schema writes.

    python scripts/Update-Org-Attributes.py
    python scripts/Update-Org-Attributes.py --check

The bridge reads the full org partition, not the fixed imported-column projection.
Its schema stays fixed when later Fabric or Azure loads introduce new attributes.
Existing org columns, calculations, relationships and security roles are preserved.
"""
import argparse
import copy
import importlib.util
import io
import json
from pathlib import Path
import re
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("org_rename", ROOT / "scripts" / "Update-Org-Department-Rename.py")
ZIP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ZIP)
TEMPLATES = ZIP.TEMPLATES + (Path("fabric") / "Add Credit Consumption" / "Consumption Central - Fabric.pbit",)
ORG = "Chat + Agent Org Data"
BRIDGE = "Org Attribute Source"
# Exact identity/internal names from the main model's lean projection, plus join
# keys. accountEnabled is intentionally not excluded: it is a useful scalar flag.
EXCLUDED = (
    "PersonId", "PersonId_Normalized", "Org Join Key", "TotalEmployees",
    "displayName", "managerUPN", "id", "UserId", "Manager_UserId",
)

# One buffered source scan, then one projection per attribute. Unlike unpivot, this
# preserves people with missing values, so grouped totals still include them.
ROWS_M = '''(Source as table, Key as text) as table =>
let
    Base = Table.Buffer(Source),
    Schema = Table.Schema(Base),
    Attrs = List.RemoveItems(Table.ColumnNames(Base), {Key, ''' + ", ".join(f'"{c}"' for c in EXCLUDED) + '''}),
    ScalarText = (v as any) as nullable text =>
        if v = null then null
        else if Value.Is(v, type datetimezone) then DateTimeZone.ToText(v, [Format="o", Culture="en-US"])
        else if Value.Is(v, type datetime) then DateTime.ToText(v, [Format="o", Culture="en-US"])
        else if Value.Is(v, type date) then Date.ToText(v, [Format="yyyy-MM-dd", Culture="en-US"])
        else if Value.Is(v, type time) then Time.ToText(v, [Format="HH:mm:ss.fffffff", Culture="en-US"])
        else Text.From(v, "en-US"),
    Blank = (v as any) as logical => v = null or Text.Trim(ScalarText(v)) = "",
    DistinctPopulated = (c as text) as number =>
        List.Count(List.Distinct(
            List.Transform(List.Select(Table.Column(Base, c), each not Blank(_)),
                each Text.TrimEnd(ScalarText(_))), Comparer.OrdinalIgnoreCase)),
    Live = List.Select(Attrs, each DistinctPopulated(_) >= 2),
    Kind = (c as text) as text =>
        let k = Table.SelectRows(Schema, each [Name] = c){0}[Kind]
        in if k = "logical" then "boolean"
           else if List.Contains({"date", "datetime", "datetimezone", "time"}, k) then k
           else if k = "number" then "number" else "string",
    One = (c as text) as table =>
        let
            // Build two named columns: source names can themselves be Value or Attribute.
            Values = Table.FromColumns({Table.Column(Base, Key),
                List.Transform(Table.Column(Base, c), each if Blank(_) then null else ScalarText(_))},
                {"PersonId_Normalized", "Value"}),
            Attribute = Table.AddColumn(Values, "Attribute", each c, type text),
            ValueKind = Kind(c),
            Typed = Table.AddColumn(Attribute, "ValueType", each ValueKind, type text),
            // A null foreign key reaches org's unknown member, preserving activity
            // from people absent from the source roster in the blank-value group.
            Unknown = #table({"PersonId_Normalized", "Attribute", "Value", "ValueType"},
                {{null, c, null, ValueKind}})
        in Table.Combine({Typed, Unknown}),
    Empty = #table({"PersonId_Normalized", "Attribute", "Value", "ValueType"}, {}),
    Out = if List.IsEmpty(Live) then Empty else Table.Combine(List.Transform(Live, One))
in
    Table.TransformColumnTypes(Out, {{"PersonId_Normalized", type text},
        {"Attribute", type text}, {"Value", type text}, {"ValueType", type text}})'''

CREDIT_START = "\t// An attribute only a handful of people"
CREDIT_END = "\tPretty = (c as text) as text =>"
CREDIT_LIVE = '''\t// Coverage and distinct-value ceilings hide useful sparse business attributes.
\t// Blanks do not count as a second value.
\tDistinctPopulated = (c as text) as number =>
\t\tList.Count(List.Distinct(
\t\t\tList.Transform(List.Select(Table.Column(Base, c), each not Blank(_)),
\t\t\t\teach Text.TrimEnd(Text.From(_, "en-US"))), Comparer.OrdinalIgnoreCase)),
\tLive = List.Select(Attrs, each DistinctPopulated(_) >= 2),
'''
CREDIT_PRETTY = '''\tPretty = (c as text) as text =>
\t\tlet
\t\t\tLabel = RawPretty(c),
\t\t\tMatches = List.Select(Live, each Text.Lower(RawPretty(_)) = Text.Lower(Label))
\t\tin if List.Count(Matches) > 1 then c else Label,
'''


def tag(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "analytics-hub/org-attributes/" + name))


def bridge_source(org_source):
    # Keep the canonical aliases and full typed source, including accountEnabled.
    text = ZIP.joined(org_source)
    if "    __lean = Table.RemoveColumns(Result," in text:
        text = text[:text.index("    // Lean pass:")] + "in\n    Result"
        # Result's comma introduced the removed lean step.
        text = text.replace("    Result = EnsureOptionalCols,\nin", "    Result = EnsureOptionalCols\nin")
    # This generated helper is not a source attribute; do not evaluate a row count
    # per person merely to discover that it has only one distinct value.
    text = text.replace("each Table.RowCount(AddPersonIdNormalized)", "each null")
    key = "Org Join Key" if 'Keyed = Table.AddColumn' in text else "PersonId_Normalized"
    return f'let\n    Source = {text},\n    Rows = ({ROWS_M})(Source, "{key}")\nin\n    Rows', key


def bridge_table(source):
    return {
        "name": BRIDGE, "lineageTag": tag(BRIDGE),
        "description": "Refresh-owned org membership by attribute. New source fields become rows on every load; missing values retain their people.",
        "columns": [
            {"name": name, "dataType": "string", "sourceColumn": name,
             "summarizeBy": "none", "lineageTag": tag(name),
             **({"isHidden": True} if name == "PersonId_Normalized" else {})}
            for name in ("PersonId_Normalized", "Attribute", "Value", "ValueType")
        ],
        "partitions": [{"name": BRIDGE, "mode": "import",
                        "source": {"type": "m", "expression": source.split("\n")}}],
    }


def credit_source(text):
    text = ZIP.joined(text)
    if CREDIT_LIVE not in text:
        if text.count(CREDIT_START) != 1 or text.count(CREDIT_END) != 1:
            raise ValueError("Consumption org eligibility query changed shape")
        start, end = text.index(CREDIT_START), text.index(CREDIT_END)
        text = text[:start] + CREDIT_LIVE + text[end:]
    if CREDIT_PRETTY not in text:
        if text.count(CREDIT_END) != 1 or text.count("\tOne = (c as text) as table =>") != 1:
            raise ValueError("Consumption org display labels changed shape")
        text = text.replace(CREDIT_END, "\tRawPretty = (c as text) as text =>")
        text = text.replace("\tOne = (c as text) as table =>", CREDIT_PRETTY + "\tOne = (c as text) as table =>")
    return text


def bridge_denominators(model):
    """Org filter resets must also reset the bridge value that cross-filters org.

    Keep Attribute: every eligible attribute retains all people, including null
    memberships. Clearing the selector would make the denominator depend on all
    attributes at once rather than the selected cohort inventory.
    """
    replacements = {
        "Licensed Users (Filter-Aware)": (
            "REMOVEFILTERS('Chat + Agent Org Data')",
            "REMOVEFILTERS('Chat + Agent Org Data'),\n"
            "        REMOVEFILTERS('Org Attribute Source'[Value])",
        ),
        "Org Credit Share %": (
            "ALL('Chat + Agent Org Data')",
            "ALL('Chat + Agent Org Data'),\n"
            "        REMOVEFILTERS('Org Attribute Source'[Value])",
        ),
    }
    expanded_fact = {
        "Efficiency - Hours Per User Per Week", "Expert Equivalent Hours Per Week",
        "Work Created - Per Week", "Last Full Month Start",
        "Cowork Fit: Surfaces Per Active Day", "Cowork Fit: Eligible Users",
        "Cowork Fit: Session Depth", "Cowork Fit: Agent User Share", "License Evidence Notice",
    }
    # Full-table modifiers clear expanded org filters, but a many-side bridge is
    # outside that expansion. Explicitly clear its Value beside the same modifier.
    fact_reset = re.compile(
        r"(?:ALL|REMOVEFILTERS)\('Chat \+ Agent Interactions \(Audit Logs\)'\)"
        r"|ALLEXCEPT\('Chat \+ Agent Interactions \(Audit Logs\)', "
        r"'Chat \+ Agent Interactions \(Audit Logs\)'\[WeekStart\]\)")
    reset_value = "REMOVEFILTERS('Org Attribute Source'[Value])"
    for table in model["tables"]:
        for measure in table.get("measures", []):
            if measure["name"] in expanded_fact:
                text = ZIP.joined(measure["expression"])
                def add_reset(match):
                    if text[match.end():].lstrip().startswith(", " + reset_value):
                        return match.group()
                    return match.group() + ", " + reset_value
                updated, count = fact_reset.subn(add_reset, text)
                if count == 0:
                    raise ValueError(f"{measure['name']}: fact filter reset changed shape")
                measure["expression"] = updated.split("\n") if isinstance(measure["expression"], list) else updated
            if measure["name"] not in replacements:
                continue
            text = ZIP.joined(measure["expression"])
            old, new = replacements[measure["name"]]
            if new in text:
                continue
            if text.count(old) != 1:
                raise ValueError(f"{measure['name']}: org denominator changed shape")
            text = text.replace(old, new)
            measure["expression"] = text.split("\n") if isinstance(measure["expression"], list) else text


def edit_model(document):
    model = document["model"]
    before = copy.deepcopy(model)
    org = next((t for t in model["tables"] if t["name"] == ORG), None)
    if org is None:
        table = ZIP.one(model["tables"], BRIDGE, "consumption tables")
        source = table["partitions"][0]["source"]
        source["expression"] = credit_source(source["expression"]).split("\n")
    else:
        source, key = bridge_source(org["partitions"][0]["source"]["expression"])
        table = next((t for t in model["tables"] if t["name"] == BRIDGE), None)
        if table is None:
            model["tables"].append(bridge_table(source))
        else:
            table["partitions"][0]["source"]["expression"] = source.split("\n")
        relationships = model.setdefault("relationships", [])
        relationship = {"name": tag("relationship"), "fromTable": BRIDGE,
                        "fromColumn": "PersonId_Normalized", "toTable": ORG, "toColumn": key,
                        "crossFilteringBehavior": "bothDirections", "securityFilteringBehavior": "oneDirection"}
        # A leaf bridge can filter org and facts without introducing another route
        # between existing tables. Never enable both directions on a reused bridge
        # that someone has also connected elsewhere.
        if any(r["name"] != relationship["name"] and
               BRIDGE in (r["fromTable"], r["toTable"]) for r in relationships):
            raise ValueError("Org attribute bridge must have exactly one relationship to avoid ambiguous filter paths")
        existing = next((r for r in relationships if r["name"] == relationship["name"]), None)
        if existing is None:
            relationships.append(relationship)
        else:
            previous = {**relationship, "crossFilteringBehavior": "oneDirection"}
            if existing not in (relationship, previous):
                raise ValueError("Org attribute bridge relationship changed unexpectedly")
            existing.update(relationship)
        bridge_denominators(model)
    return before != model


def edit_pending(document, model):
    before = copy.deepcopy(document)
    query = next((q for q in document["queries"] if q["name"] == BRIDGE), None)
    table = ZIP.one(model["tables"], BRIDGE, "model tables")
    source = ZIP.joined(table["partitions"][0]["source"]["expression"])
    if query is None:
        document["queries"].append({
            "name": BRIDGE, "lineageTag": tag(BRIDGE), "text": source.split("\n"),
            "isDirectQuery": False, "loadAsTableDisabled": False, "resultType": "Table", "isHidden": False,
        })
    else:
        old = ZIP.joined(query["text"])
        query["text"] = source.split("\n")
        ZIP.set_last_loaded(query, old, source)
    return before != document


def build(original):
    infos, payloads, comment = ZIP.read_archive(original)
    document, encode = ZIP.codec(payloads["DataModelSchema"], "DataModelSchema")
    changed = []
    if edit_model(document):
        payloads["DataModelSchema"] = encode(document)
        changed.append("DataModelSchema")
    if "UnappliedChanges" in payloads:
        pending, encode_pending = ZIP.codec(payloads["UnappliedChanges"], "UnappliedChanges")
        if edit_pending(pending, document["model"]):
            payloads["UnappliedChanges"] = encode_pending(pending)
            changed.append("UnappliedChanges")
    if not changed:
        return original, []
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.comment = comment
        for info in infos:
            archive.writestr(copy.copy(info), payloads[info.filename])
    return output.getvalue(), changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    stale = False
    for relative in TEMPLATES:
        path = ROOT / relative
        rebuilt, changes = build(path.read_bytes())
        print(("stale" if args.check else "updated") if changes else "current", relative)
        if changes:
            stale = True
            if not args.check:
                path.write_bytes(rebuilt)
    return int(stale and args.check)


if __name__ == "__main__":
    raise SystemExit(main())
