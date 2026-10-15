"""Emit the synthetic benchmark's column contract, executable Spark derivation and DAX checks.

This command only writes local validation artifacts. It never deploys, refreshes, or queries a
service. Run emitted DAX against baseline and optimized models on identical data and filters.
The emitted Spark function returns a candidate DataFrame; it does not overwrite its input.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "fabric" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"
FACT = "Chat + Agent Interactions (Audit Logs)"
TARGET = "copilot_interactions_curated"
FUNCTIONS = {"L", "chain", "_notblank", "_has", "_dax_trim", "_hash_key", "slim_model_columns"}
CONSTANTS = {"BEHAVIOR_GROUP", "MATERIAL_TYPES", "SLIM_COLS"}
THREAD_INPUTS = ["ThreadId", "AppHost", "AccessedResource_Type"]
MESSAGE_INPUTS = ["Message_Id", "AppHost", "AccessedResource_Type"]
SOURCES = {
    "Is_Cowork": ["AppHost"],
    "AppHost_Norm": ["AppHost"],
    "Agent Filter (Normalized)": ["AppHost", "Is_Agent_Activity", "AgentId"],
    "Session Turn Band": ["ThreadId"],
    "Session Turn Band Sort": ["ThreadId"],
    "Model Cost Tier": ["AI_Model"],
    "Model Cost Tier Sort": ["AI_Model"],
    "Work Weight Grade": THREAD_INPUTS,
    "Work Weight Grade Sort": THREAD_INPUTS,
    "Session Material Refs": THREAD_INPUTS,
    "Session Material Types": THREAD_INPUTS,
    "Cowork Task Category": MESSAGE_INPUTS,
    "Task Breakdown Category": [*MESSAGE_INPUTS, "Behavior_Enriched_Full"],
    "Is Prompt Row": ["Message_isPrompt"],
    "Is Observed Prompt": ["Message_isPrompt", "Audit_UserId", "Message_Id", "ThreadId"],
    "Task Engagement Mode": [*MESSAGE_INPUTS, "Usage_Mode"],
    "Task Breakdown Group": [*MESSAGE_INPUTS, "Behavior_Enriched_Full"],
    "Fit Basis": THREAD_INPUTS,
    "Work Shape": THREAD_INPUTS,
    "Work Shape Sort": THREAD_INPUTS,
    "Session Model Tier": ["ThreadId", "AI_Model"],
    "Session Model Tier Sort": ["ThreadId", "AI_Model"],
    "Expertise Role (All Cohorts)": ["AppHost", "AccessedResource_Type", "AccessedResource_Action", "Expertise_Role"],
    "Is Usage Row": ["AppHost", "Message_isPrompt"],
    "Thread_Key": ["ThreadId"],
    "Message_Key": ["Message_Id"],
}


def spark_code():
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    source = "".join(notebook["cells"][14]["source"])
    nodes = []
    found = set()
    for node in ast.parse(source).body:
        name = node.name if isinstance(node, ast.FunctionDef) else (
            node.targets[0].id if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) else None)
        if name in FUNCTIONS | CONSTANTS:
            found.add(name)
            nodes.append(ast.get_source_segment(source, node))
    if found != FUNCTIONS | CONSTANTS:
        raise ValueError(f"Notebook derivation dependencies changed: {(FUNCTIONS | CONSTANTS) - found}")
    return "from pyspark.sql import Column, Window, functions as F\n\n" + "\n\n".join(nodes) + "\n"


PREFLIGHT = '''

REQUIRED_INPUTS = __REQUIRED_INPUTS__


def build_candidate(source):
    """Derive columns from COMPLETE already-curated history; do not use a capped/month-only sample."""
    missing = sorted(set(REQUIRED_INPUTS) - set(source.columns))
    if missing:
        raise ValueError(f"Cannot backfill model columns; missing source fields: {missing}")
    candidate = slim_model_columns(source)
    for raw, key in (("ThreadId", "Thread_Key"), ("Message_Id", "Message_Key")):
        if source.where(F.col(raw) != F.rtrim(F.col(raw))).limit(1).count():
            raise ValueError(f"{raw} contains trailing spaces; resolve baseline DAX semantics before migration")
        pairs = candidate.select(F.lower(F.col(raw)).alias("original"), F.col(key).alias("key")).distinct()
        collisions = pairs.groupBy("key").count().where("count > 1").limit(1).count()
        if collisions:
            raise ValueError(f"{key} collision; do not switch models or accept approximate counts")
    return candidate
'''


def emit(destination):
    destination.mkdir(parents=True, exist_ok=True)
    code = spark_code() + PREFLIGHT.replace("__REQUIRED_INPUTS__", repr(sorted({c for v in SOURCES.values() for c in v})))
    compile(code, "spark_slimming.py", "exec")
    (destination / "spark_slimming.py").write_text(code, encoding="utf-8")
    manifest = {
        "target_table": TARGET,
        "source": str(NOTEBOOK.relative_to(ROOT)),
        "source_sha256": hashlib.sha256(NOTEBOOK.read_bytes()).hexdigest(),
        "spark_derivation_sha256": hashlib.sha256(code.encode()).hexdigest(),
        "entry_point": "build_candidate(source_dataframe)",
        "writes": False,
        "requires": "Complete curated history with all source fields; no typed-null or fabricated source substitutes.",
        "comparison": "Exact integer/count/boolean/group membership; abs(new-old) <= abs(old)*1e-9 for decimals; zero exact.",
        "columns": [{"name": name, "source_columns": fields, "target_table": TARGET,
                     "code": "spark_slimming.py:slim_model_columns"} for name, fields in SOURCES.items()],
        "key_bindings": {"ThreadId": "Thread_Key", "Message_Id": "Message_Key"},
        "synthetic_cross_month_rows": [6, 9, 9, 6],
        "large_fixture_rows": None,
    }
    (destination / "column-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    queries = destination / "dax"
    queries.mkdir(exist_ok=True)
    for index, name in enumerate(list(SOURCES)[:24], 1):
        dax = (f"EVALUATE\nSUMMARIZECOLUMNS('{FACT}'[{name}], "
               f'"Rows", COUNTROWS(\'{FACT}\'))\nORDER BY \'{FACT}\'[{name}]\n')
        (queries / f"{index:02d}-column-groups.dax").write_text(dax, encoding="utf-8")
    headline = f"""EVALUATE
ROW(
    "Rows", COUNTROWS('{FACT}'),
    "Users", DISTINCTCOUNT('{FACT}'[Audit_UserId]),
    "Sessions", [Observed Sessions],
    "Thread groups", DISTINCTCOUNT('{FACT}'[ThreadId]),
    "Message groups", DISTINCTCOUNT('{FACT}'[Message_Id]),
    "Usage rows", CALCULATE(COUNTROWS('{FACT}'), '{FACT}'[Is Usage Row] = TRUE()),
    "First day", MIN('Calendar'[Date]),
    "Last day", MAX('Calendar'[Date])
)
"""
    (queries / "00-headlines.dax").write_text(headline, encoding="utf-8")
    print(f"Emitted 26-column manifest, read-only Spark candidate builder and 25 paired DAX checks to {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    emit(parser.parse_args().out)
