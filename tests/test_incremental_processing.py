"""Incremental curated processing: plan helper, and incremental == full rebuild on the Azure path.

The Azure job curates with valuelens_core one month file at a time. These tests feed it a history,
then add late-arriving rows (inside and outside the lookback window) and drop a month, and check the
incremental result against a from-scratch full rebuild of the same source. Others run each `process`
as the Azure run job does, in a new container: an AdlsStore over the same blobs, with an empty folder.
"""
from __future__ import annotations

import datetime
import shutil
from pathlib import Path
from types import SimpleNamespace

import duckdb
import pytest

from valuelens_core import incremental as inc
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs.storage import AdlsStore, LocalStore

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
    jobs_main.main(["process", "--data-dir", str(tmp_path)], env={"VALUELENS_PROCESS_PASS_ROWS": "0"})
    default = jobs_main.DEFAULT_PROCESS_PASS_ROWS
    assert [(c["full_rebuild"], c["lookback_days"], c["max_rows_per_pass"]) for c in calls] == [
        (True, 14, default), (True, 30, default), (False, 14, default), (False, 14, 0)]


# ---------------------------------------------------------------- Azure job: processing passes
def test_passes_split_whole_months_in_order():
    src = {"2026-07": "3:1", "2026-08": "4:1", "2026-09": "9:1", "2026-10": "2:1", "none": "1:1"}
    months = list(src)
    assert jobs_main._passes(months, src, 7) == [["2026-07", "2026-08"], ["2026-09"], ["2026-10", "none"]]
    assert jobs_main._passes(months, src, 1) == [[k] for k in months]
    assert jobs_main._passes(months, src, 0) == [months]
    assert jobs_main._passes([], src, 7) == [[]]


def test_chunked_full_rebuild_matches_nightly_runs(tmp_path, sample_rows, caplog):
    # One month per pass: each pass sees the history as nightly runs that met the months in turn built it.
    base, con = sample_rows
    chunked = _new_store(tmp_path, "chunked", base)
    _write_parsed(chunked, con)
    with caplog.at_level("INFO", logger="valuelens_jobs"):
        total = jobs_main.process(chunked, full_rebuild=True, max_rows_per_pass=1)
    assert "in 4 passes" in caplog.text
    nightly = _new_store(tmp_path, "nightly", base)
    for where in ("CreationDate::VARCHAR < '2026-08'", "CreationDate::VARCHAR < '2026-09'",
                  "CreationDate::VARCHAR < '2026-10'", "TRUE"):
        _write_parsed(nightly, con, where)
        jobs_main.process(nightly, lookback_days=0)
    assert _curated(chunked) == _curated(nightly)

    one = _new_store(tmp_path, "one", base)
    _write_parsed(one, con)
    assert jobs_main.process(one, full_rebuild=True) == total
    # Only the snapshot columns of the older months differ from a single pass.
    assert _curated(chunked, ["2026-10"]) == _curated(one, ["2026-10"])
    assert _curated(chunked, exclude=SNAPSHOT_COLS) == _curated(one, exclude=SNAPSHOT_COLS)


def test_chunked_backfill_matches_one_pass(tmp_path, sample_rows, caplog):
    # A first run on recent rows, then the older history arrives at once, as a "load more" backfill does.
    base, con = sample_rows
    stores, totals = {}, {}
    for name, max_rows in (("chunked", 1), ("one", 0)):
        store = stores[name] = _new_store(tmp_path, name, base)
        _write_parsed(store, con, "CreationDate::VARCHAR >= '2026-09-06'")
        jobs_main.process(store, lookback_days=14)
        _write_parsed(store, con)
        with caplog.at_level("INFO", logger="valuelens_jobs"):
            totals[name] = jobs_main.process(store, lookback_days=14, max_rows_per_pass=max_rows)
    assert "in 4 passes" in caplog.text
    assert totals["chunked"] == totals["one"]
    assert _curated(stores["chunked"], ["2026-10"]) == _curated(stores["one"], ["2026-10"])
    assert _curated(stores["chunked"], exclude=SNAPSHOT_COLS) == _curated(stores["one"], exclude=SNAPSHOT_COLS)


def test_stopped_chunked_run_resumes_with_the_months_left(tmp_path, sample_rows, monkeypatch):
    base, con = sample_rows
    whole = _new_store(tmp_path, "whole", base)
    _write_parsed(whole, con)
    total = jobs_main.process(whole, lookback_days=0, max_rows_per_pass=1)

    store = _new_store(tmp_path, "stopped", base)
    _write_parsed(store, con)
    real, calls = jobs_main.curate, []

    def stop_in_third_pass(*args, **kwargs):
        calls.append(1)
        if len(calls) == 3:
            raise RuntimeError("stopped")
        return real(*args, **kwargs)

    monkeypatch.setattr(jobs_main, "curate", stop_in_third_pass)
    with pytest.raises(RuntimeError, match="stopped"):
        jobs_main.process(store, lookback_days=0, max_rows_per_pass=1)
    # The two finished passes are saved; the next run curates only September and October.
    assert sorted(store.read_json(jobs_main.PROCESS_STATE)["months"]) == ["2026-07", "2026-08"]
    assert _month_files(store) == ["month-202607.parquet", "month-202608.parquet"]
    assert jobs_main.process(store, lookback_days=0, max_rows_per_pass=1) == total
    assert len(calls) == 5
    assert _curated(store) == _curated(whole)


# ---------------------------------------------------------------- Azure job: a new container every run
class _BlobService:
    """Blob containers in memory, as AdlsStore sees them, noting each blob downloaded and uploaded."""

    def __init__(self):
        self.blobs, self.downloads, self.uploads = {}, [], []

    def get_container_client(self, container):
        return _BlobContainer(self, container)

    def upload_folder(self, root):
        """Upload every file under a local folder laid out like the store."""
        for f in sorted(Path(root).rglob("*")):
            if f.is_file():
                container, _, name = f.relative_to(root).as_posix().partition("/")
                self.blobs[(container, name)] = f.read_bytes()


class _BlobContainer:
    def __init__(self, service, container):
        self.service, self.container = service, container

    def list_blobs(self, name_starts_with, include=None):
        return [SimpleNamespace(name=n, metadata={}, last_modified=None)
                for c, n in sorted(self.service.blobs) if c == self.container and n.startswith(name_starts_with)]

    def download_blob(self, name):
        self.service.downloads.append(f"{self.container}/{name}")
        data = self.service.blobs[(self.container, name)]
        return SimpleNamespace(readinto=lambda fh: fh.write(data))

    def upload_blob(self, name, fh, overwrite=False):
        self.service.uploads.append(f"{self.container}/{name}")
        self.service.blobs[(self.container, name)] = fh.read()

    def delete_blob(self, name):
        self.service.blobs.pop((self.container, name), None)


def _new_container(tmp_path, name, service):
    # What every Azure run gets: an AdlsStore over the same blobs, with a new, empty local folder.
    return AdlsStore("acct", root=tmp_path / name, service=service)


def _files(prefix, months):
    return {f"{prefix}/month-{m}.parquet" for m in months}


def _month_blobs(names):
    """The month files among blob names, sorted, with any repeats."""
    return sorted(n for n in names if "/month-" in n)


def test_incremental_run_in_a_new_container_pulls_the_months_it_keeps(tmp_path, sample_rows, caplog):
    base, con = sample_rows
    seed, service = _new_store(tmp_path, "seed", base), _BlobService()
    _write_parsed(seed, con)
    service.upload_folder(seed.root)
    first_run = _new_container(tmp_path, "run1", service)
    first = jobs_main.process(first_run)
    service.downloads.clear()
    service.uploads.clear()

    with caplog.at_level("INFO", logger="valuelens_jobs"):
        assert jobs_main.process(_new_container(tmp_path, "run2", service)) == first
    # The next run is incremental: July and August lie outside the 14-day lookback window, so they're kept.
    assert "process: incremental (incremental); 2 month(s) to curate: 2026-09, 2026-10" in caplog.text
    # It pulls the kept months' context and the curated months it reads, and rewrites only its own months.
    assert _month_blobs(service.downloads) == sorted(
        _files(CURATED, ["202607", "202608", "202609", "202610"])
        | _files(jobs_main.PROCESS_CONTEXT, ["202607", "202608"]))
    assert _month_blobs(service.uploads) == sorted(
        _files(CURATED, ["202609", "202610"]) | _files(jobs_main.PROCESS_CONTEXT, ["202609", "202610"]))
    stored = _new_container(tmp_path, "stored", service)
    stored.pull(CURATED)
    assert _curated(stored) == _curated(first_run)


def test_new_container_pulls_each_file_once_in_passes_and_none_on_a_full_rebuild(tmp_path, sample_rows, caplog):
    base, con = sample_rows
    late = "(CreationDate::VARCHAR LIKE '2026-07-2%' AND hash(Id) % 2 = 0)"
    seed, service = _new_store(tmp_path, "seed", base), _BlobService()
    _write_parsed(seed, con, f"NOT {late}")
    service.upload_folder(seed.root)
    jobs_main.process(_new_container(tmp_path, "run1", service), lookback_days=3)
    _write_parsed(seed, con)                # the late July rows arrive
    service.upload_folder(seed.root)
    service.downloads.clear()

    # July (late rows) and October (lookback), in passes of one month.
    with caplog.at_level("INFO", logger="valuelens_jobs"):
        total = jobs_main.process(_new_container(tmp_path, "run2", service), lookback_days=3,
                                  max_rows_per_pass=1)
    assert "2 month(s) to curate: 2026-07, 2026-10" in caplog.text and "in 2 passes" in caplog.text
    # The July pass pulls the kept months' context and the curated months it sees. The October pass then
    # pulls only October's: it reads July as the July pass wrote it, and the kept months the July pass pulled.
    assert _month_blobs(service.downloads) == sorted(
        _files(CURATED, ["202607", "202608", "202609", "202610"])
        | _files(jobs_main.PROCESS_CONTEXT, ["202608", "202609"]))
    local = _new_store(tmp_path, "local", base)
    _write_parsed(local, con, f"NOT {late}")
    jobs_main.process(local, lookback_days=3)
    _write_parsed(local, con)
    assert jobs_main.process(local, lookback_days=3, max_rows_per_pass=1) == total
    stored = _new_container(tmp_path, "stored", service)
    stored.pull(CURATED)
    assert _curated(stored) == _curated(local)

    # A full rebuild reads only the months it writes, in passes too, so it pulls none of the history.
    service.downloads.clear()
    assert jobs_main.process(_new_container(tmp_path, "run3", service), full_rebuild=True,
                             max_rows_per_pass=1) == total
    assert not _month_blobs(service.downloads)


# ---------------------------------------------------------------- Fabric processor notebook
PROCESSOR_NB = ROOT / "fabric" / "notebooks" / "Copilot_Audit_Log_Processor.ipynb"
# Token hash (comments and layout ignored) of the processor transform cells 2 and 4-14, per
# PROCESSOR_LOGIC_VERSION. A change that alters curated rows must bump the version so the next
# run rebuilds every month; then add the new hash here. A change that does not alter rows
# (refactor, logging) only needs the hash updated.
PROCESSOR_LOGIC_HASHES = {
    1: "e10f273b3ab216ebdacbb5b04e8b7e5eb933504fa26b0c7887e48dffbe3fe09d",
    2: "bfe5e2dca281c8bb305092ffe9f7ca6bc3a84b009cbf4889873de99f0e20b96e",
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
    writer = code[15]
    assert "update_conversation_history(df, spark.table(OUT_TABLE)" in writer
    assert 'plan = {**plan, "months": months}' in writer
    assert "localCheckpoint" not in "\n".join(code)
    assert "write_strategy, PROCESS_PLAN = publish_curated_output(fact, PROCESS_PLAN)" in writer
    assert ".partitionBy(PARTITION_COLUMN)" in writer
    assert '.option("replaceWhere", month_predicate_sql(PARTITION_COLUMN, plan["months"]))' in writer
    assert "save_processor_state(build_processor_state(PROCESSOR_CONFIG, SOURCE_MONTHS), intent)" in writer
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


def _ingester_backfill_cell():
    import json
    nb = json.loads(INGESTER_NB.read_text(encoding="utf-8"))
    return next("".join(c["source"]) for c in nb["cells"]
                if c["cell_type"] == "code" and "def write_backfill(" in "".join(c["source"]))


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
    # The backfill helpers partition a new or rebuilt table and migrate an unpartitioned one, once,
    # before a merge or a backfill replaces rows. The writer's MERGE is bounded to the batch's months.
    helpers = _ingester_backfill_cell()
    assert helpers.count(".partitionBy(partition_column)") == 2
    assert "_table_partition_columns(table_name) != [partition_column]" in helpers
    assert "ensure_month_partitions(OUTPUT_TABLE)" in cell
    assert "merge(df.alias('s'), cond)" in cell
