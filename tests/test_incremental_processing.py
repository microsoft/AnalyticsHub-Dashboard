"""Incremental curated processing: plan helper, and incremental == full rebuild on the Azure path.

The Azure job curates with valuelens_core one month file at a time. These tests feed it a history,
then add late-arriving rows (inside and outside the lookback window) and drop a month, and check the
incremental result against a from-scratch full rebuild of the same source.
"""
from __future__ import annotations

import datetime
import shutil
from pathlib import Path

import duckdb
import pytest

from valuelens_core import incremental as inc
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs.storage import LocalStore

ROOT = Path(__file__).resolve().parents[1]
PARSED = "raw/copilot_interactions_parsed"
CURATED = "curated/copilot_interactions_curated"
# Snapshot of "now" for an agent; a kept (not recomputed) month keeps the value it was written with.
SNAPSHOT_COLS = ["Agent Last Used Date"]


# ---------------------------------------------------------------- plan helper
def test_plan_full_rebuild_triggers():
    src = {"2026-08": "1:1", "2026-09": "2:2"}
    state = inc.parse_processor_state(inc.build_processor_state("cfg", src))
    assert inc.plan_incremental_months(src, state, "cfg", force_full=True)["full"]
    assert inc.plan_incremental_months(src, None, "cfg")["full"]
    assert inc.plan_incremental_months(src, state, "other")["full"]
    migrate = inc.plan_incremental_months(src, state, "cfg", target_ready=False)
    assert migrate["full"] and migrate["months"] == ["2026-08", "2026-09"]


def test_plan_picks_changed_vanished_and_lookback_months():
    saved = {"2026-06": "5:5", "2026-07": "5:5", "2026-08": "5:5", "2026-09": "5:5", "none": "1:1"}
    state = inc.parse_processor_state(inc.build_processor_state("cfg", saved))
    src = {"2026-06": "6:9", "2026-08": "5:5", "2026-09": "5:5", "none": "1:1"}   # 06 grew, 07 gone
    plan = inc.plan_incremental_months(src, state, "cfg", max_creation=datetime.datetime(2026, 9, 10, 8),
                                       lookback_days=14)
    # 2026-09-10 minus 14 days is 2026-08-27, so August and September are in the lookback window.
    assert plan == {"full": False, "reason": "incremental", "months": ["2026-06", "2026-07", "2026-08", "2026-09"]}
    quiet = inc.plan_incremental_months(saved, state, "cfg", max_creation=None)
    assert quiet["months"] == [] and not quiet["full"]


def test_state_round_trip_and_bad_state():
    text = inc.build_processor_state("cfg", {"2026-09": "3:7"})
    assert inc.parse_processor_state(text) == {"version": 1, "config": "cfg", "months": {"2026-09": "3:7"}}
    for bad in (None, "", "not json", "[]", '{"version": 99, "config": "c", "months": {}}'):
        assert inc.parse_processor_state(bad) is None


def test_month_key():
    assert inc.month_key(datetime.date(2026, 9, 3)) == "2026-09"
    assert inc.month_key("2026-09-03T10:00:00Z") == "2026-09"
    assert inc.month_key(None) == inc.month_key("garbage") == inc.NULL_MONTH
    assert inc.month_start("2026-09") == datetime.date(2026, 9, 1) and inc.month_start("none") is None


# ---------------------------------------------------------------- Azure job: incremental == full
@pytest.fixture(scope="module")
def sample_rows(tmp_path_factory):
    from valuelens_jobs import sample

    base = tmp_path_factory.mktemp("sample")
    sample.load(LocalStore(base), folder=ROOT / "samples", today=datetime.date(2026, 10, 6))
    con = duckdb.connect()
    con.execute(f"CREATE TABLE parsed AS SELECT * FROM read_parquet('{(base / PARSED).as_posix()}/*.parquet', "
                f"union_by_name=true)")
    return base, con


def _write_parsed(store, con, where="TRUE"):
    folder = store.path(PARSED)
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    con.execute(f"COPY (SELECT * FROM parsed WHERE {where}) TO '{(folder / 'part.parquet').as_posix()}' "
                f"(FORMAT PARQUET)")


def _new_store(tmp_path, name, base):
    store = LocalStore(tmp_path / name)
    for prefix in ("raw/copilot_licensed_users", "raw/agents_365"):
        if (base / prefix).exists():
            shutil.copytree(base / prefix, store.path(prefix))
    return store


def _curated(store, months=None, exclude=()):
    glob = f"read_parquet('{store.path(CURATED).as_posix()}/*.parquet', union_by_name=true)"
    cols = duckdb.sql(f"SELECT * FROM {glob} LIMIT 0").columns
    keep = ", ".join('"' + c + '"' for c in sorted(cols) if c not in exclude)
    where = "TRUE" if months is None else f"strftime(MonthStart, '%Y-%m') IN ({', '.join(repr(m) for m in months)})"
    return duckdb.sql(f"SELECT {keep} FROM {glob} WHERE {where} ORDER BY ALL").fetchall()


def _month_files(store):
    return sorted(p.name for p in store.path(CURATED).glob("*.parquet"))


# Late rows: some September rows (outside a 3-day lookback) and the newest days arrive a day late.
LATE = "(CreationDate::VARCHAR >= '2026-10-03' OR (CreationDate::VARCHAR LIKE '2026-09-1%' AND hash(Id) % 3 = 0))"


def test_incremental_equals_full_rebuild_with_late_rows(tmp_path, sample_rows):
    base, con = sample_rows
    inc_store = _new_store(tmp_path, "inc", base)
    _write_parsed(inc_store, con, f"NOT {LATE}")
    first = jobs_main.process(inc_store, lookback_days=3)
    assert _month_files(inc_store) == ["month-202607.parquet", "month-202608.parquet", "month-202609.parquet", "month-202610.parquet"]
    august = inc_store.path(f"{CURATED}/month-202608.parquet").stat().st_mtime_ns

    _write_parsed(inc_store, con)          # the late rows arrive
    total = jobs_main.process(inc_store, lookback_days=3)
    assert total > first
    # August's source did not change and is outside the lookback window: not rewritten.
    assert inc_store.path(f"{CURATED}/month-202608.parquet").stat().st_mtime_ns == august

    full_store = _new_store(tmp_path, "full", base)
    _write_parsed(full_store, con)
    assert jobs_main.process(full_store, full_rebuild=True) == total
    # Recomputed months (September by fingerprint, October by lookback) match a full rebuild exactly.
    assert _curated(inc_store, ["2026-09", "2026-10"]) == _curated(full_store, ["2026-09", "2026-10"])
    # Kept months match too, apart from the documented snapshot columns.
    assert _curated(inc_store, exclude=SNAPSHOT_COLS) == _curated(full_store, exclude=SNAPSHOT_COLS)


def test_old_month_recompute_uses_kept_months_for_history_wide_values(tmp_path, sample_rows):
    # Late rows land only in July, so July is recomputed while August and September are kept:
    # an agent's last-used date for July rows must come from the kept months.
    base, con = sample_rows
    late = "(CreationDate::VARCHAR LIKE '2026-07-2%' AND hash(Id) % 2 = 0)"
    inc_store = _new_store(tmp_path, "inc", base)
    _write_parsed(inc_store, con, f"NOT {late}")
    jobs_main.process(inc_store, lookback_days=3)
    _write_parsed(inc_store, con)
    total = jobs_main.process(inc_store, lookback_days=3)
    full_store = _new_store(tmp_path, "full", base)
    _write_parsed(full_store, con)
    assert jobs_main.process(full_store, full_rebuild=True) == total
    assert _curated(inc_store, ["2026-07", "2026-10"]) == _curated(full_store, ["2026-07", "2026-10"])
    assert _curated(inc_store, exclude=SNAPSHOT_COLS) == _curated(full_store, exclude=SNAPSHOT_COLS)


def test_vanished_month_is_removed_and_rerun_is_a_no_op(tmp_path, sample_rows):
    base, con = sample_rows
    store = _new_store(tmp_path, "s", base)
    _write_parsed(store, con)
    jobs_main.process(store, lookback_days=3)
    _write_parsed(store, con, "CreationDate::VARCHAR >= '2026-08'")    # July purged at the source
    total = jobs_main.process(store, lookback_days=3)
    assert _month_files(store) == ["month-202608.parquet", "month-202609.parquet", "month-202610.parquet"]
    assert not store.path("curated/_valuelens_process/context/month-202607.parquet").exists()

    full = _new_store(tmp_path, "f", base)
    _write_parsed(full, con, "CreationDate::VARCHAR >= '2026-08'")
    assert jobs_main.process(full, full_rebuild=True) == total
    assert _curated(store, exclude=SNAPSHOT_COLS) == _curated(full, exclude=SNAPSHOT_COLS)

    september = store.path(f"{CURATED}/month-202609.parquet").stat().st_mtime_ns
    assert jobs_main.process(store, lookback_days=3) == total
    assert store.path(f"{CURATED}/month-202609.parquet").stat().st_mtime_ns == september


def test_legacy_single_file_is_migrated_once(tmp_path, sample_rows):
    base, con = sample_rows
    store = _new_store(tmp_path, "legacy", base)
    _write_parsed(store, con)
    legacy = store.path(f"{CURATED}/part-0.parquet")
    legacy.parent.mkdir(parents=True)
    duckdb.sql("SELECT 1 AS Id").write_parquet(str(legacy))
    total = jobs_main.process(store)
    assert not legacy.exists()
    assert _month_files(store) == ["month-202607.parquet", "month-202608.parquet", "month-202609.parquet", "month-202610.parquet"]
    assert duckdb.sql(f"SELECT count(*) FROM read_parquet('{store.path(CURATED).as_posix()}/*.parquet')"
                      ).fetchone()[0] == total


def test_settings_change_forces_full_rebuild(tmp_path, sample_rows):
    base, con = sample_rows
    store = _new_store(tmp_path, "cfg", base)
    _write_parsed(store, con)
    kept = jobs_main.process(store, lookback_days=3)
    kept_all = jobs_main.process(store, lookback_days=3, exclude_agent_identities=False)
    assert kept_all >= kept
    full = _new_store(tmp_path, "cfg_full", base)
    _write_parsed(full, con)
    assert jobs_main.process(full, exclude_agent_identities=False) == kept_all
    assert _curated(store) == _curated(full)


def test_process_cli_full_rebuild_flag(tmp_path, sample_rows, monkeypatch):
    calls = []
    monkeypatch.setattr(jobs_main, "process", lambda store, **k: calls.append(k))
    jobs_main.main(["process", "--data-dir", str(tmp_path), "--full-rebuild"], env={})
    jobs_main.main(["process", "--data-dir", str(tmp_path)],
                   env={"VALUELENS_PROCESS_FULL_REBUILD": "true", "VALUELENS_PROCESS_LOOKBACK_DAYS": "30"})
    jobs_main.main(["process", "--data-dir", str(tmp_path)], env={})
    assert [(c["full_rebuild"], c["lookback_days"]) for c in calls] == [(True, 14), (True, 30), (False, 14)]

# ---------------------------------------------------------------- Fabric processor notebook
PROCESSOR_NB = ROOT / "fabric" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"
# Token hash (comments and layout ignored) of the processor transform cells 2 and 4-14, per
# PROCESSOR_LOGIC_VERSION. A change that alters curated rows must bump the version so the next
# run rebuilds every month; then add the new hash here. A change that does not alter rows
# (refactor, logging) only needs the hash updated.
PROCESSOR_LOGIC_HASHES = {
    1: "e10f273b3ab216ebdacbb5b04e8b7e5eb933504fa26b0c7887e48dffbe3fe09d",
    2: "6074bad5d35f80b0322a2b17f38e20265cf1aace0de43b5c979ade3a48c575ae",
}


def _processor_code():
    import json
    nb = json.loads(PROCESSOR_NB.read_text(encoding="utf-8"))
    return ["".join(c["source"]) if c["cell_type"] == "code" else "" for c in nb["cells"]]


def _token_text(src: str) -> str:
    import io
    import tokenize
    skip = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT,
            tokenize.ENDMARKER}
    return " ".join(t.string for t in tokenize.generate_tokens(io.StringIO(src).readline) if t.type not in skip)


def test_processor_logic_version_tracks_transform_cells():
    import hashlib
    import re
    code = _processor_code()
    version = int(re.search(r"^PROCESSOR_LOGIC_VERSION = (\d+)$", code[2], re.M).group(1))
    digest = hashlib.sha256("\n".join(_token_text(code[i]) for i in [2, *range(4, 15)] if code[i])
                            .encode("utf-8")).hexdigest()
    assert PROCESSOR_LOGIC_HASHES.get(version) == digest, (
        "Copilot_Audit_Log_Processor transform cells changed. If curated rows can change, bump "
        f"PROCESSOR_LOGIC_VERSION (now {version}) so existing tables rebuild; then set "
        f"PROCESSOR_LOGIC_HASHES[{version}] = {digest!r} in this test.")


def test_processor_notebook_is_incremental_and_skew_free():
    code = _processor_code()
    assert "plan_incremental_months(" in code[3] and "SOURCE_MONTHS" in code[3]
    assert 'F.xxhash64(*_hash_cols)' in code[3]
    # Kept-month context feeds the two cross-month values.
    assert "KEPT_SCHEMA_AGENT_IDS" in code[3] and "KEPT_SCHEMA_AGENT_IDS" in code[11]
    assert "KEPT_AGENT_LAST_USED" in code[3] and "KEPT_AGENT_LAST_USED" in code[14]
    # The AgentName window put every row without an agent into one task.
    assert 'Window.partitionBy("AgentName")' not in code[14]
    assert 'F.broadcast(_alu)' in code[14]
    assert "update_conversation_history(fact, spark.table(OUT_TABLE)" in code[14]
    assert 'PROCESS_PLAN = {**PROCESS_PLAN, "months": _conversation_months}' in code[14]
    writer = code[15]
    assert ".partitionBy(PARTITION_COLUMN)" in writer
    assert '.option("replaceWhere", month_predicate_sql(PARTITION_COLUMN, plan["months"]))' in writer
    assert "save_processor_state(build_processor_state(PROCESSOR_CONFIG, SOURCE_MONTHS))" in writer
    assert ".merge(" not in writer and "tgt.delete(" not in writer
    # Month keys must be derived exactly as MonthStart is in the dates cell.
    assert 'F.trunc(F.to_date(F.to_timestamp(F.col("CreationDate"))), "month")' in code[3]
    assert 'F.to_timestamp("CreationDate")' in code[7] and 'F.trunc(F.col("InteractionDate"), "month")' in code[7]


def test_month_predicate_sql():
    assert inc.month_predicate_sql("MonthStart", []) == "FALSE"
    assert (inc.month_predicate_sql("MonthStart", ["2026-09", "2026-08"])
            == "(`MonthStart` IN (DATE'2026-08-01', DATE'2026-09-01'))")
    assert (inc.month_predicate_sql("MonthStart", ["none", "2026-09"])
            == "(`MonthStart` IN (DATE'2026-09-01') OR `MonthStart` IS NULL)")
    assert inc.month_predicate_sql("MonthStart", ["none"]) == "(`MonthStart` IS NULL)"
    con = duckdb.connect()
    con.execute("CREATE TABLE t AS SELECT * FROM (VALUES (DATE '2026-08-01'), (DATE '2026-09-01'), (NULL)) v(MonthStart)")
    pred = inc.month_predicate_sql("MonthStart", ["none", "2026-09"]).replace("`", '"')
    assert sorted(map(str, (r[0] for r in con.execute(f"SELECT MonthStart FROM t WHERE {pred}").fetchall()))) == ["2026-09-01", "None"]


# ---------------------------------------------------------------- Fabric audit-log ingester
INGESTER_NB = ROOT / "fabric" / "notebooks" / "Copilot_Audit_Log_Direct_Ingester.ipynb"


def _ingester_writer_cell():
    import json
    nb = json.loads(INGESTER_NB.read_text(encoding="utf-8"))
    return next("".join(c["source"]) for c in nb["cells"]
                if c["cell_type"] == "code" and "def write_output(df):" in "".join(c["source"]))


def test_ingester_merge_is_bounded_to_batch_months():
    import ast
    cell = _ingester_writer_cell()
    tree = ast.parse(cell)
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "month_bounded_merge_condition")
    ns = {}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), "ingester", "exec"), ns)
    cond = ns["month_bounded_merge_condition"]
    assert cond([]) == "t.`Id` = s.`Id`"
    assert (cond([datetime.date(2026, 9, 1), datetime.date(2026, 8, 1), datetime.date(2026, 9, 1)])
            == "t.`Id` = s.`Id` AND (t.`MonthStart` IN (DATE'2026-08-01', DATE'2026-09-01'))")
    assert (cond([None, datetime.date(2026, 9, 1)])
            == "t.`Id` = s.`Id` AND (t.`MonthStart` IN (DATE'2026-09-01') OR t.`MonthStart` IS NULL)")
    assert cond([None]) == "t.`Id` = s.`Id` AND (t.`MonthStart` IS NULL)"
    # Partitioned on overwrite, one-time migration of an unpartitioned table, bounded MERGE.
    assert cell.count(".partitionBy(PARTITION_COLUMN)") == 2
    assert "_table_partition_columns(OUTPUT_TABLE) != [PARTITION_COLUMN]" in cell
    assert "merge(df.alias('s'), cond)" in cell
