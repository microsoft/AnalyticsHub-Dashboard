"""Cross-month additions, changed identities and removals use complete conversation context."""
import datetime

import duckdb
import pytest

from conversation_parity import COLUMNS, fixture, run_spark
from test_incremental_processing import SNAPSHOT_COLS
from test_valuelens_core_parity import _spark_available
from valuelens_core import processor
from valuelens_jobs import __main__ as jobs
from valuelens_jobs.storage import LocalStore


def write_source(store, rows):
    target = store.path(jobs.PROCESS_INPUTS[0] + "/fixture.parquet")
    target.parent.mkdir(parents=True, exist_ok=True)
    with duckdb.connect() as con:
        con.execute("CREATE TABLE source (" + ", ".join(f'"{c}" VARCHAR' for c in COLUMNS) + ")")
        con.executemany("INSERT INTO source VALUES (" + ",".join("?" for _ in COLUMNS) + ")", rows)
        con.sql("SELECT * FROM source").write_parquet(str(target))


def output(store):
    files = sorted(store.path(jobs.CURATED_PREFIX).glob("*.parquet"))
    return duckdb.read_parquet([str(p) for p in files], union_by_name=True)


def comparable(store):
    rel = output(store)
    columns = [c for c in sorted(rel.columns) if c not in SNAPSHOT_COLS]
    return rel.project(", ".join(f'"{c}"' for c in columns)).order("Id").fetchall()


def test_azure_cross_month_append_rekey_and_delete_match_full(tmp_path):
    incremental = LocalStore(tmp_path / "incremental")
    write_source(incremental, fixture())
    assert jobs.process(incremental, lookback_days=0) == 6
    independent = incremental.path(jobs.CURATED_PREFIX + "/month-202605.parquet")
    independent_stamp = independent.stat().st_mtime_ns
    for stage in (1, 2, 3):
        rows = fixture(stage)
        write_source(incremental, rows)
        assert jobs.process(incremental, lookback_days=0) == len(rows)
        full = LocalStore(tmp_path / f"full-{stage}")
        write_source(full, rows)
        assert jobs.process(full, full_rebuild=True) == len(rows)
        assert comparable(incremental) == comparable(full), f"stage {stage}"
        assert independent.stat().st_mtime_ns == independent_stamp
        assert output(incremental).filter("Id = 'b'").project('"Session Turn Band"').fetchone()[0] == "2-3 turns"


def test_conversation_updates_preserve_snapshot_values_and_noop():
    # A minimal already-curated frame isolates propagation from the monthly planner.
    with duckdb.connect() as con:
        con.execute("""CREATE TABLE input AS SELECT * FROM (VALUES
            ('old', 'T', 'M', DATE '2026-07-01', 'historical'),
            ('new', 't', 'm', DATE '2026-10-01', 'current'))
            t(Id, ThreadId, Message_Id, MonthStart, "License Status")""")
        defaults = {
            "AccessedResource_Type": "message", "AccessedResource_Action": "read", "AppHost": "Cowork",
            "Message_isPrompt": "true", "Audit_UserId": "person@example.invalid", "AgentId": None,
            "AI_Model": "gpt-5", "Expertise_Role": "Assistant", "Usage_Mode": "1 - Asking",
            "Behavior_Enriched_Full": "general assistance",
        }
        for name, value in defaults.items():
            con.execute(f'ALTER TABLE input ADD COLUMN "{name}" VARCHAR')
            con.execute(f'UPDATE input SET "{name}" = ?', [value])
        con.execute("ALTER TABLE input ADD COLUMN Is_Agent_Activity BOOLEAN DEFAULT FALSE")
        f = processor.Frame(con, "input", "fixture")
        try:
            processor._slim(f)
            con.execute(f'CREATE TABLE current AS SELECT * FROM "{f.name}"')
        finally:
            f.cleanup()
        con.execute("CREATE TABLE changed AS SELECT ThreadId, Message_Id FROM current WHERE Id = 'new'")
        updated, dirty = processor.update_conversations(con, "current", "changed", output="updated")
        assert dirty == []
        assert updated.order("Id").fetchall() == con.sql("SELECT * FROM current ORDER BY Id").fetchall()
        con.execute("""UPDATE current SET AccessedResource_Type = 'text/markdown',
                       "Model Cost Tier Sort" = 0 WHERE Id = 'new'""")
        updated, dirty = processor.update_conversations(con, "current", "changed", output="updated")
        assert set(dirty) == {datetime.date(2026, 7, 1), datetime.date(2026, 10, 1)}
        assert updated.order("Id").project('"License Status"').fetchall() == [("current",), ("historical",)]
        # The row-local column is preserved, not silently recalculated while updating its groups.
        assert updated.filter("Id = 'new'").project('"Model Cost Tier Sort"').fetchone()[0] == 0


@pytest.mark.skipif(not _spark_available(), reason="pyspark/Java not installed")
def test_spark_cross_month_append_rekey_and_delete_match_full():
    from valuelens_golden import spark_session

    assert [r["rows"] for r in run_spark(spark_session())] == [9, 9, 6]
