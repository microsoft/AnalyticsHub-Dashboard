"""Build the offline demo exclusively from the repository's published synthetic samples."""
import ast
import csv
import hashlib
import json
import platform
import re
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "core"))
import duckdb
from valuelens_core.processor import curate


def read(name):
    with (ROOT / "samples" / name).open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def reference_table(model, name):
    table = next(table for table in model["tables"] if table["name"] == name)
    lines = table["partitions"][0]["source"]["expression"]
    start = next(i for i, line in enumerate(lines) if "Source = #table(" in line)
    header = next(csv.reader([lines[start + 1].strip().rstrip(",").strip("{}")], skipinitialspace=True))
    records = []
    for line in lines[start + 3:]:
        value = line.strip()
        if value == "}":
            break
        if not value.startswith('{"'):
            continue
        cells = next(csv.reader([value.rstrip(",").strip("{}")], skipinitialspace=True))
        if len(cells) != len(header):
            raise ValueError(f"{name}: unexpected reference row {value}")
        records.append(dict(zip(header, cells)))
    return records


def build():
    con = duckdb.connect()
    con.read_csv(str(ROOT / "samples" / "copilot_interactions_sample.csv"), all_varchar=True).create_view("activity_input")
    con.read_csv(str(ROOT / "samples" / "copilot_users_sample.csv"), all_varchar=True).create_view("people_input")
    con.read_csv(str(ROOT / "samples" / "agents_365_sample.csv"), all_varchar=True).create_view("agents_input")
    # These are published curated samples, not a new raw ingestion run. Keep every
    # source row while adding the current application's classification columns.
    curated = curate(con, "activity_input", "people_input", "agents_input",
                     exclude_agent_identities=False, drop_exclude_reasons=())
    columns = curated.columns
    records = [dict(zip(columns, row)) for row in curated.fetchall()]
    names = {
        "date": "ActivityDate", "week": "WeekStart", "month": "MonthStart",
        "user": "Audit_UserId", "app": "AppHost_Norm", "agent": "AgentName",
        "agentType": "Agent_Type", "audience": "Agent Filter (Normalized)", "thread": "ThreadId",
        "message": "Message_Id", "behavior": "Behavior_Enriched_Full", "category": "Task Breakdown Category",
        "group": "Task Breakdown Group", "outcome": "Value_Outcome", "resource": "AccessedResource_Type",
        "grade": "Work Weight Grade", "shape": "Work Shape", "basis": "Fit Basis",
        "model": "AI_Model", "tier": "Model Cost Tier", "sessionTier": "Session Model Tier",
        "workflow": "Workflow_Action", "coworkCategory": "Cowork Task Category",
    }
    activity = []
    for row in records:
        item = {key: str(row.get(column) or "") for key, column in names.items()}
        for key in ("date", "week", "month"):
            item[key] = item[key][:10]
        item.update(
            prompt=bool(row["Is Prompt Row"]), observed=bool(row["Is Observed Prompt"]),
            licensed=row["License Status"] == "M365 Copilot Licensed", cowork=bool(row["Is_Cowork"]),
            refs=int(row.get("Session Material Refs") or 0), types=int(row.get("Session Material Types") or 0),
        )
        activity.append(item)
    people = [{
        "user": row["PersonId"].lower(), "name": row["displayName"], "org": row["Organization"],
        "licensed": row["Has license"].lower() in ("yes", "true", "1"), "job": row["JobTitle"],
        "country": row["country"],
        "active": row["accountEnabled"].lower() in ("yes", "true", "1"),
    } for row in read("copilot_users_sample.csv")]
    template = ROOT / "fabric" / "ValueLens - Fabric.pbit"
    with zipfile.ZipFile(template) as archive:
        model = json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]
    glossary_source = next(table for table in model["tables"] if table["name"].endswith("Metric Glossary"))["partitions"][0]["source"]["expression"]
    glossary_header = re.findall(r'"([^"]+)",(?:STRING|INTEGER)', glossary_source[0])
    glossary = [dict(zip(glossary_header, next(csv.reader([line.strip().rstrip(",").strip("{}")], skipinitialspace=True))))
                for line in glossary_source[1:] if line.strip().startswith('{"')]
    seeder = ROOT / "fabric" / "Add Credit Consumption" / "seed_sample_data.py"
    term_call = next(node for node in ast.walk(ast.parse(seeder.read_text(encoding="utf-8")))
                     if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "put"
                     and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == "commercial_terms")
    terms = ast.literal_eval(term_call.args[1].args[0])[0]
    inputs = sorted((ROOT / "samples").rglob("*.csv")) + [
        template, seeder, Path(__file__).resolve(), *sorted((ROOT / "core" / "valuelens_core").glob("*.py"))]
    payload = {
        "provenance": {
            "description": "Published synthetic CSV samples; no live Fabric or tenant export; dates are not shifted.",
            "classification": "Shared core classification with ingestion exclusions disabled to preserve the published curated sample rows.",
            "inputActivityRows": len(read("copilot_interactions_sample.csv")),
            "outputActivityRows": len(activity),
            "runtime": {"python": platform.python_version(), "duckdb": duckdb.__version__},
            "files": {str(file.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(file.read_bytes()).hexdigest() for file in inputs},
        },
        "activity": activity, "people": people, "agents": read("agents_365_sample.csv"),
        "feedback": read("product_feedback_sample.csv"),
        "times": reference_table(model, "Human Time Estimates"),
        "signals": reference_table(model, "Behavior Value Map"),
        "glossary": glossary,
        "terms": terms,
        "consumption": {file.stem: read(f"consumption/{file.name}") for file in sorted((ROOT / "samples" / "consumption").glob("*.csv"))},
    }
    out = ROOT / "app" / "src" / "demo" / "sample-data.generated.json"
    out.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str) + "\n", encoding="utf-8")
    print(f"Built synthetic demo: {len(activity):,} activity rows, {len(people)} people; {out.stat().st_size:,} bytes")
    con.close()


if __name__ == "__main__":
    build()
