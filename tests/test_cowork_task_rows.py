from __future__ import annotations

import json
from pathlib import Path

import duckdb

from valuelens_core import audit


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "cowork_scheduled_runs.jsonl"
INGESTER = ROOT / "1. Fabric" / "Manual setup" / "notebooks" / "Copilot_Audit_Log_Direct_Ingester.ipynb"
def fixture_rows() -> list[dict]:
    return [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]


def cowork_records() -> list[dict]:
    return fixture_rows()[:6]


def negative_record() -> dict:
    return fixture_rows()[6]


def test_fabric_ingester_source_has_cowork_task_row_rule():
    source = "\n".join(
        "".join(cell.get("source", []))
        for cell in json.loads(INGESTER.read_text(encoding="utf-8"))["cells"]
        if cell.get("cell_type") == "code"
    )
    assert "def is_cowork_autonomous" in source
    assert "_task_row_record = _copilot_studio_runtime | _cowork_autonomous" in source
    assert ".withColumn('Prompts_Available', F.when(_has_prompt_messages" in source
    assert ".withColumn('_Task_Row_Placeholder'" in source
    assert "F.when(F.col('_Task_Row_Placeholder'), F.array(_empty_message))" in source
    assert "F.when(F.col('_Task_Row_Placeholder'), F.array(_empty_resource))" in source
    assert "F.when(F.col('_Task_Row_Placeholder'), F.lit('message:none'))" in source
    assert "Copilot Cowork scheduled/autonomous runs" in source


def test_duckdb_audit_keeps_one_cowork_task_row_per_record():
    rows = fixture_rows()
    con = duckdb.connect()
    con.execute("CREATE TABLE staged (" + ", ".join(f'"{c}" VARCHAR' for c in audit.STAGE_COLUMNS) + ")")
    con.executemany(
        "INSERT INTO staged VALUES (" + ", ".join("?" for _ in audit.STAGE_COLUMNS) + ")",
        [[r.get(c) for c in audit.STAGE_COLUMNS] for r in rows],
    )
    rel = audit.flatten(con, "staged")
    got = [dict(zip(rel.columns, row)) for row in rel.fetchall()]

    expected_threads = {
        json.loads(r["AuditData"])["CopilotEventData"]["ThreadId"]
        for r in cowork_records()
    }
    assert {r["RecordId"] for r in got} == {r["RecordId"] for r in cowork_records()}
    assert negative_record()["RecordId"] not in {r["RecordId"] for r in got}
    assert len(got) == 6
    assert {r["ThreadId"] for r in got} == expected_threads
    for row in got:
        assert row["AppHost"] == "cowork"
        assert row["AgentName"] == "Copilot Cowork"
        assert row["Audit_UserId"] == "user1@example.com"
        assert row["Message_Id"] == "message:none"
        assert row["Message_isPrompt"] == "false"
        assert row["Source_MessageKey"] == "message:none"
        assert row["Source_ResourceKey"] == "resource:none"
        assert row["Resource_Ordinal"] == 0
