"""Slim the ValueLens audit fact so the model fits small Fabric capacities at 30-40k users.

The audit fact used to carry 31 DAX calculated columns. VertiPaq builds those on every
refresh, in memory, after the import, which is what pushed large tenants past the
3 GB per-model limit of F2-F8, and Direct Lake cannot have them at all. The processor
(notebook Copilot_Audit_Log_Processor, its DuckDB twin core/valuelens_core and the Azure
process job) now writes the 24 that the report reads as physical columns, so this
script:

* turns those 24 into imported data columns, keeping name, type, lineage, sort-by,
  visibility and descriptions, so visuals and measures bind unchanged;
* drops the 7 helper columns that only fed them (Session Type Blob, Session Surfaces,
  Session Surface List, Session Build Artifact, Session Message Reads, Is Material Ref,
  Fit Rule Step);
* keeps ThreadId and Message_Id under the same names but binds them to the processor's
  60-bit integer Thread_Key / Message_Key instead of the unique-per-row id text, so
  every measure, report and app query that counts sessions or prompts runs unchanged
  on old and new models alike;
* drops CreationDate, whose per-second timestamp is near-unique: the Calendar and the
  agent last-activity DAX read InteractionDate (the same day, so the same answers);
* stops the fact query importing the id text and CreationDate, and adds the
  processor-built columns as typed nulls when the curated table predates them, so an
  older lakehouse still refreshes (those visuals stay blank until the processor runs).

    python scripts/Update-Model-Slimming.py           # patch the templates in place
    python scripts/Update-Model-Slimming.py --check   # exit 1 if any template is stale

scripts/Update-Template-Dax.py owns the Calendar table and the usage measures; both
scripts must report every template current. Desktop refresh still needs live QA, see
docs/MODEL-SLIMMING.md.
"""
import argparse
import copy
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("template_dax", ROOT / "scripts" / "Update-Template-Dax.py")
TEMPLATE_DAX = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(TEMPLATE_DAX)

VALUELENS = TEMPLATE_DAX.VALUELENS
AUDIT = TEMPLATE_DAX.AUDIT
A = TEMPLATE_DAX.A

# Former calculated columns the processor now writes, with their model and M types.
# Order matches SLIM_COLS in core/valuelens_core/processor.py (tests check it).
SLIM_COLUMNS = (
    ("Is_Cowork", "boolean"), ("AppHost_Norm", "string"), ("Agent Filter (Normalized)", "string"),
    ("Session Turn Band", "string"), ("Session Turn Band Sort", "int64"), ("Model Cost Tier", "string"),
    ("Model Cost Tier Sort", "int64"), ("Work Weight Grade", "string"), ("Work Weight Grade Sort", "int64"),
    ("Session Material Refs", "int64"), ("Session Material Types", "int64"), ("Cowork Task Category", "string"),
    ("Task Breakdown Category", "string"), ("Is Prompt Row", "boolean"), ("Is Observed Prompt", "boolean"),
    ("Task Engagement Mode", "string"), ("Task Breakdown Group", "string"), ("Fit Basis", "string"),
    ("Work Shape", "string"), ("Work Shape Sort", "int64"), ("Session Model Tier", "string"),
    ("Session Model Tier Sort", "int64"), ("Expertise Role (All Cohorts)", "string"), ("Is Usage Row", "boolean"),
)
# Model columns that keep their name but now import the processor's integer key.
KEYS = {"ThreadId": "Thread_Key", "Message_Id": "Message_Key"}
KEY_DESCRIPTION = {
    "ThreadId": "Session (thread) identity as a 60-bit integer key: the processor's Thread_Key, a hash of "
                "the thread id, not the id text. Count it; do not display it.",
    "Message_Id": "Prompt (message) identity as a 60-bit integer key: the processor's Message_Key, a hash "
                  "of the message id, not the id text. Count it; do not display it.",
}
# Helper calculated columns that only fed the ones above.
HELPER_COLUMNS = (
    "Session Type Blob", "Session Surfaces", "Session Surface List", "Session Build Artifact",
    "Session Message Reads", "Is Material Ref", "Fit Rule Step",
)
# Imported column the model no longer reads, and what DAX now reads instead.
REPLACED = {"CreationDate": "InteractionDate"}
M_TYPES = {"boolean": "type logical", "int64": "Int64.Type", "string": "type text"}

TRIMMED = (
    "AccessedResource_SiteUrl", "Delegation_Event_Key", "AccessedResource_SensitivityLabelId", "AISystemPlugin_Id",
    "AISystemPlugin_Name", "AppIdentity_AppId", "AppIdentity_DisplayName", "AppIdentity_PublisherId",
    "ApplicationName", "Audit_UserKey", "Agent_EntraId", "Agent_TitleID", "Agent Last Used Date", "ClientRegion",
    "Is_Sensitive", "ModelTransparencyDetails_ModelName", "ModelTransparencyDetails_ModelProviderName",
    "Web_Grounded_Signal", "Workload", "Has license", "SensitivityLabelId", "Behavior_Source", "Behavior_Enriched",
    "User_Stage", "UserMonthKey", "Resource_Count", "Grounding Source", "Agent_Surface", "Execution_Trigger",
    "AppIdentity_Text", "Agent_TargetPlatformId", "Agent_TargetName", "Agent_PlatformType",
    "ThreadId", "Message_Id", "CreationDate",
)


def _m_list(items, indent):
    pad = " " * indent
    return ",\n".join(f"{pad}{item}" for item in items)


FACT_M = "\n".join((
    "let",
    "    // Value Lens 2307 (Spark) update: audit-log shaping now happens once in Spark",
    "    // (notebook Copilot_Audit_Log_Processor -> Delta table copilot_interactions_curated).",
    "    // Thin, query-folding passthrough: a single CreationDate range filter that folds to the",
    "    // Lakehouse SQL endpoint so Incremental Refresh only touches new day-partitions",
    "    // (and the model is Direct Lake-ready). Every column comes straight from the processor.",
    "    Source   = FabricTable(\"copilot_interactions_curated\"),",
    "    Filtered = Table.SelectRows(Source, each [CreationDate] >= RangeStart and [CreationDate] < RangeEnd),",
    "    // Drop columns no visual or measure reads. This folds to a SQL projection,",
    "    // and removes 444 MB of AccessedResource_SiteUrl from every refresh. ThreadId,",
    "    // Message_Id and CreationDate are near-unique per row: the model's ThreadId and",
    "    // Message_Id columns import the processor's integer Thread_Key / Message_Key and",
    "    // dates come from InteractionDate instead (docs/MODEL-SLIMMING.md).",
    "    Trimmed = Table.RemoveColumns(Filtered, {" + ", ".join(f'"{c}"' for c in TRIMMED) + "}, MissingField.Ignore),",
    "    // The processor writes these former calculated columns. A curated table written by",
    "    // an older processor lacks them: add them as typed nulls so refresh still succeeds",
    "    // (their visuals stay blank until the processor runs again). Nothing is added, and",
    "    // the query still folds, once the columns exist.",
    "    Processed = {",
    _m_list([f'{{"{n}", {M_TYPES[t]}}}' for n, t in SLIM_COLUMNS] + [f'{{"{k}", Int64.Type}}' for k in KEYS.values()], 8),
    "    },",
    "    Missing = List.Select(Processed, each not List.Contains(Table.ColumnNames(Trimmed), _{0})),",
    "    Slimmed = List.Accumulate(Missing, Trimmed, (t, c) => Table.AddColumn(t, c{0}, each null, c{1}))",
    "in",
    "    Slimmed",
))

_REF = re.compile(r"'Chat \+ Agent Interactions \(Audit Logs\)'\[(CreationDate)\]")


def rewrite(expression):
    """Point DAX at InteractionDate instead of the dropped CreationDate."""
    return _REF.sub(lambda m: f"{A}[{REPLACED[m.group(1)]}]", expression)


def text(value):
    return "\n".join(value) if isinstance(value, list) else value


def expressions(model):
    """Yield (record, field) for every DAX expression in the model."""
    for table in model["tables"]:
        for measure in table.get("measures", []):
            yield measure, "expression"
        for column in table.get("columns", []):
            if column.get("type") == "calculated":
                yield column, "expression"
        for partition in table.get("partitions", []):
            if partition["source"].get("type") == "calculated":
                yield partition["source"], "expression"


def data_column(column):
    """A calculated column record turned into an imported column with the same metadata."""
    result = {}
    for key, value in column.items():
        if key in ("type", "expression", "isDataTypeInferred"):
            continue
        result[key] = value
        if key == "dataType":
            result["sourceColumn"] = column["name"]
    return result


def key_column(column):
    """The id text column rebound to its integer key, keeping name, lineage and annotations."""
    name = column["name"]
    result = {"name": name, "dataType": "int64", "isHidden": True, "formatString": "0",
              "sourceColumn": KEYS[name], "description": KEY_DESCRIPTION[name]}
    for key, value in column.items():
        if key not in result and key != "summarizeBy":
            result[key] = value
    result["summarizeBy"] = "none"
    return result


def apply(model):
    """Patch the model in place; return the list of changes (empty when already current)."""
    changed = []
    fact = TEMPLATE_DAX.find_table(model, AUDIT)
    columns = fact["columns"]
    by_name = {c["name"]: c for c in columns}
    if len(by_name) != len(columns):
        raise ValueError(f"duplicate column names in {AUDIT}")
    types = dict(SLIM_COLUMNS)
    rebuilt = []
    for column in columns:
        name = column["name"]
        if name in types:
            if column.get("dataType") != types[name]:
                raise ValueError(f"{AUDIT}[{name}] is {column.get('dataType')}, expected {types[name]}")
            if column.get("type") == "calculated":
                column = data_column(column)
                changed.append(f"data column {name}")
            elif column.get("sourceColumn") != name:
                raise ValueError(f"{AUDIT}[{name}] is neither calculated nor imported from {name}")
        elif name in HELPER_COLUMNS:
            changed.append(f"drop {name}")
            continue
        elif name in KEYS:
            if column.get("sourceColumn") == KEYS[name] and column.get("dataType") == "int64":
                pass
            elif column.get("sourceColumn") == name and column.get("dataType") == "string":
                column = key_column(column)
                changed.append(f"{name} imports {KEYS[name]}")
            else:
                raise ValueError(f"{AUDIT}[{name}] is neither the id text nor its integer key")
        elif name in REPLACED:
            if column.get("type") == "calculated":
                raise ValueError(f"{AUDIT}[{name}] is unexpectedly calculated")
            changed.append(f"drop {name}")
            continue
        rebuilt.append(column)
    missing = [n for n in list(types) + list(KEYS) if n not in {c["name"] for c in rebuilt}]
    if missing:
        raise ValueError(f"{AUDIT} lacks {missing}")
    fact["columns"] = rebuilt
    names = {c["name"] for c in rebuilt}
    for column in rebuilt:
        if column.get("sortByColumn") and column["sortByColumn"] not in names:
            raise ValueError(f"{AUDIT}[{column['name']}] sorts by a missing column")

    wanted = TEMPLATE_DAX.model_text(FACT_M)
    partitions = fact["partitions"]
    if len(partitions) != 1 or partitions[0]["source"].get("type") != "m":
        raise ValueError(f"{AUDIT} is not a single M partition")
    if partitions[0]["source"]["expression"] != wanted:
        partitions[0]["source"]["expression"] = wanted
        changed.append("partition M")
    policy = fact.get("refreshPolicy")
    if policy is None:
        raise ValueError(f"{AUDIT} has no incremental refresh policy")
    if policy.get("sourceExpression") != wanted:
        policy["sourceExpression"] = wanted
        changed.append("refresh policy M")

    for record, field in expressions(model):
        before = text(record[field])
        after = rewrite(before)
        if after != before:
            record[field] = TEMPLATE_DAX.model_text(after)
            changed.append(f"DAX {record.get('name', 'calculated table')}")
    return changed


def masked(model):
    """The model with the owned parts removed and DAX normalised, for the unrelated-fields check."""
    result = copy.deepcopy(model)
    fact = TEMPLATE_DAX.find_table(result, AUDIT)
    for key in ("columns", "partitions", "refreshPolicy"):
        fact.pop(key, None)
    for record, field in expressions(result):
        record[field] = rewrite(text(record[field]))
    return result


def build(original):
    infos, payloads, comment = TEMPLATE_DAX.read_archive(original)
    raw = payloads["DataModelSchema"].decode("utf-16-le")
    newline = "\r\n" if "\r\n" in raw else "\n"
    document = json.loads(raw)
    if TEMPLATE_DAX.dump(document, newline) != payloads["DataModelSchema"]:
        raise ValueError("DataModelSchema does not round-trip; refusing to rewrite it")
    before = copy.deepcopy(document["model"])
    changed = apply(document["model"])
    if not changed:
        return original, changed
    if masked(before) != masked(document["model"]):
        raise ValueError("unrelated model fields changed")
    if apply(copy.deepcopy(document["model"])):
        raise ValueError("patch is not idempotent")
    payloads["DataModelSchema"] = TEMPLATE_DAX.dump(document, newline)
    return repack(infos, payloads, comment), changed


def repack(infos, payloads, comment):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.comment = comment
        for info in infos:
            archive.writestr(copy.copy(info), payloads[info.filename])
    rebuilt = output.getvalue()
    after_infos, after_payloads, after_comment = TEMPLATE_DAX.read_archive(rebuilt)
    if after_comment != comment or [i.filename for i in after_infos] != [i.filename for i in infos]:
        raise ValueError("ZIP members, order or comment changed")
    for old, new in zip(infos, after_infos):
        if any(getattr(old, key) != getattr(new, key) for key in TEMPLATE_DAX.ZIP_METADATA):
            raise ValueError(f"ZIP metadata changed: {old.filename}")
        if old.filename != "DataModelSchema" and payloads[old.filename] != after_payloads[new.filename]:
            raise ValueError(f"unrelated ZIP member changed: {old.filename}")
    return rebuilt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="report stale templates without writing")
    args = parser.parse_args(argv)
    stale = 0
    for relative in VALUELENS:
        path = ROOT / relative
        original = path.read_bytes()
        rebuilt, changed = build(original)
        if not changed:
            print(f"current  {relative}")
            continue
        stale += 1
        if args.check:
            print(f"stale    {relative}: {len(changed)} changes", file=sys.stderr)
            continue
        if path.read_bytes() != original:
            raise ValueError(f"{relative} changed during rebuild; refusing to overwrite")
        path.write_bytes(rebuilt)
        print(f"updated  {relative}: {len(changed)} changes")
    return 1 if args.check and stale else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Model slimming update failed: {error}", file=sys.stderr)
        sys.exit(1)
