"""valuelens-jobs entry point.

    python -m valuelens_jobs run --steps collect,process,publish,refresh
    python -m valuelens_jobs run --data-dir <dir> --steps process      # local / mounted data
    python -m valuelens_jobs run --steps access,refresh                # org-scoped access only (the installer)
    python -m valuelens_jobs process --data-dir <dir>
    python -m valuelens_jobs migrate

Step order mirrors the Fabric CopilotAdoptionPipeline. Without `--data-dir` the job works on the
ADLS account in VALUELENS_STORAGE_ACCOUNT with its managed identity.

Data layout (same under a local directory or the ADLS account; first segment = container):
    raw/copilot_interactions_parsed/day-YYYYMMDD.parquet
    raw/copilot_licensed_users/part-0.parquet
    raw/copilot_org_data/part-0.parquet                        (data source workday may add its columns in place)
    raw/copilot_org_data_workday_preview/part-0.parquet        (data source workday: the enriched copy to review)
    raw/m365_activity_daily/day-YYYYMMDD.parquet
    raw/defender_*/...                                         (module defender, optional)
    landing/defender/ai_watchlist.csv                          (module defender: the AI watchlist, admin-edited)
    raw/agents_365/part-0.parquet                              (module agent365: the newest Agent 365 export)
    raw/user_feedback/part-0.parquet                           (module productFeedback: every export, deduplicated)
    raw/agent_<sessions|turns|errors|subagents|performance>/month-YYYYMM.parquet
                                                               (module agentEvaluator: Copilot Studio transcripts)
    raw/agent_catalogue/part-0.parquet, raw/evaluator_status/part-0.parquet  (module agentEvaluator)
    raw/_state/audit.json, raw/_state/agent_evaluator.json     (what the incremental collectors last read; for audit
                                                               also where the load had got to for the last process
                                                               step and the last publish, for `status`)
    raw/_state/refresh.json                                    (a full model refresh a later run still owes)
    raw/_state/run.lock                                        (the run lock: leased by the run that's going, which
                                                               records which run it is; see runlock.py)
    raw/_state/chain.json                                      (how many runs started the next one today, UTC; see
                                                               continue_run.py)
    curated/copilot_interactions_curated/month-YYYYMM.parquet  (one file per month; month-none = no date)
    curated/_valuelens_process/state.json, context/            (incremental process bookkeeping)
    curated/<studio_* | viva_*>/part-0.parquet                 (module consumption, merged state)
    raw/<azure_ai_* | copilot_payg_spend | ...>/part-0.parquet (module consumption, Azure AI)
    landing/studio/*.csv, landing/viva/*.csv                   (consumption drop folder, read only)
    landing/agent365/*.csv                                     (module agent365 drop folder, read only)
    landing/product_feedback/*.csv                             (module productFeedback drop folder, read only)
    landing/workday/*.csv                                      (data source workday drop folder, read only)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from valuelens_core import creation_timestamp_sql, curate
from valuelens_core.incremental import (DEFAULT_INCREMENTAL_LOOKBACK_DAYS, NULL_MONTH, build_processor_state,
                                        parse_processor_state, plan_incremental_months,
                                        processor_config_fingerprint)
from valuelens_core.processor import conversation_predicate_sql, update_conversations

from . import continue_run, runlock
from .config import Settings
from .storage import LeaseHeld, LocalStore, open_store
from .tables import parquet_glob, q

log = logging.getLogger("valuelens_jobs")
STEPS = ("collect", "process", "publish", "access", "refresh")
# What a run does when --steps isn't given. The access sync is part of publish; "access" runs it alone.
DEFAULT_STEPS = ("collect", "process", "publish", "refresh")
CURATED_PREFIX = "curated/copilot_interactions_curated"
CURATED_LEGACY = CURATED_PREFIX + "/part-0.parquet"
# Bookkeeping for incremental runs, outside the curated folder so publish never reads it.
PROCESS_STATE = "curated/_valuelens_process/state.json"
PROCESS_CONTEXT = "curated/_valuelens_process/context"
PROCESS_INPUTS = ("raw/copilot_interactions_parsed", "raw/copilot_licensed_users", "raw/agents_365")
# Source rows one processing pass curates. More (a long backfill, or a full rebuild of a large tenant) run as
# passes of whole months, oldest first, so memory and spill follow the largest pass, not the whole history.
DEFAULT_PROCESS_PASS_ROWS = 2_000_000
# The run job's replica timeout when VALUELENS_JOB_TIMEOUT_SEC (set from the same Bicep variable) is missing.
DEFAULT_JOB_TIMEOUT_SEC = 14_400
# Kept back from the audit fetch for the merge, process, publish and refresh: this, or RESERVE_FACTOR times the
# last run's merge-to-publish time when that's longer.
MIN_RESERVE_SEC = 3_600
RESERVE_FACTOR = 1.5
# The refresh step stops waiting this long before the replica timeout, so the run ends before it's stopped.
REFRESH_MARGIN_SEC = 600


@dataclass
class RunBudget:
    """The run's time limits, as readings of `clock`, counted from the job's start."""
    clock: object
    start: float
    timeout_s: float
    reserve_s: float
    fetch_deadline: float
    override_min: float | None = None

    @property
    def hard_deadline(self) -> float:
        return self.start + self.timeout_s

    @property
    def refresh_deadline(self) -> float:
        return self.hard_deadline - REFRESH_MARGIN_SEC

    def left(self) -> float:
        return self.hard_deadline - self.clock()


def _seconds(environ, name, default, scale=1.0, minimum=0.0):
    raw = environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        value = float(raw) * scale
        if not math.isfinite(value) or value < minimum:
            raise ValueError(raw)
        return value
    except ValueError:
        log.warning("%s=%r isn't a number we can use; %s", name, raw,
                    "ignored" if default is None else f"using {default:.0f} seconds")
        return default


def run_budget(store, environ, *, start, clock=time.monotonic, settle=False) -> RunBudget:
    """The run's time budget, counted from the job's start (`start`, a reading of `clock`).

    The hard deadline is the run job's replica timeout, VALUELENS_JOB_TIMEOUT_SEC (14,400 seconds when it's
    missing). The audit fetch stops a reserve before it: 60 minutes, or 1.5 times the last run's
    merge-to-publish time when that's longer. VALUELENS_AUDIT_TIME_BUDGET_MIN replaces that with minutes counted
    from the job's start, capped at the hard deadline.

    A `merge_open` left in the audit state means the last run merged and was stopped before it published, so
    its merge-to-publish time was at least the time it had left (`cutoff_s`). With `settle` (a run that collects)
    that becomes the last run's time in the state, so the reserve grows to cover it.
    """
    timeout = _seconds(environ, "VALUELENS_JOB_TIMEOUT_SEC", float(DEFAULT_JOB_TIMEOUT_SEC), minimum=1.0)
    last = 0.0
    if store is not None:
        from .collect.audit import STATE

        try:
            state = store.read_json(STATE, {}) or {}
            last = float(state.get("last_merge_to_publish_s") or 0)
            opened = state.get("merge_open")
            if isinstance(opened, dict):
                cutoff = float(opened.get("cutoff_s") or 0)
                last = max(last, cutoff)
                if settle:
                    log.warning("run: the last run merged audit history at %s and was stopped before it published; "
                                "it had %.0f min left, so this run keeps at least %.0f min back",
                                opened.get("started_at"), cutoff / 60, RESERVE_FACTOR * last / 60)
                    state.pop("merge_open", None)
                    state["last_merge_to_publish_s"] = round(last, 1)
                    store.write_json(STATE, state)
        except Exception as exc:
            log.warning("run: couldn't read the last run's merge-to-publish time from %s (%s); keeping %s min back",
                        STATE, exc, MIN_RESERVE_SEC // 60)
            last = 0.0
    reserve = max(float(MIN_RESERVE_SEC), RESERVE_FACTOR * last)
    override = _seconds(environ, "VALUELENS_AUDIT_TIME_BUDGET_MIN", None, scale=60.0)
    fetch = start + (min(override, timeout) if override is not None else max(timeout - reserve, 0.0))
    return RunBudget(clock, start, timeout, reserve, fetch,
                     override / 60 if override is not None else None)


def _start_owed_rebuild(store, budget, requested=False) -> bool:
    """Whether this run's process rebuilds every month: requested, or owed since the history loaded.

    Months merged newest first can curate differently from one pass over the history (an agent link found in an
    older month), so once the history is loaded the tables are rebuilt once: in the run that finishes the load if
    it has twice the reserve left, otherwise in the next run, whatever time that one has left.
    """
    from .collect.audit import STATE

    try:
        state = store.read_json(STATE, {}) or {}
    except Exception as exc:
        log.warning("process: couldn't read %s (%s); a rebuild owed once the history loaded waits for a later run",
                    STATE, exc)
        return requested
    if not state.get("full_rebuild_owed"):
        return requested
    if not requested and budget is not None and not state.get("full_rebuild_deferred"):
        need, left = 2 * budget.reserve_s, budget.left()
        if left < need:
            # Once only: a reserve over a quarter of the run's limit would otherwise put it off for good.
            state["full_rebuild_deferred"] = True
            store.write_json(STATE, state)
            log.warning("process: the rebuild owed now the history is loaded waits for the next run: %.0f min left, "
                        "%.0f min wanted", max(left, 0) / 60, need / 60)
            return False
    # Without the processing state, a run stopped before the first pass is saved still rebuilds every month next
    # time. Each pass saves the state, so a run stopped later resumes with the months still to do.
    store.remove([PROCESS_STATE])
    state.pop("full_rebuild_owed", None)
    state.pop("full_rebuild_deferred", None)
    store.write_json(STATE, state)
    log.info("process: rebuilding every month once, as the history was loaded newest first")
    return True


def _merge_open(store):
    from .collect.audit import STATE

    state = store.read_json(STATE, {}) or {}
    return state, state.pop("merge_open", None)


def _record_merge_to_publish(store, budget):
    """Record how long this run took from the audit merge to the end of publish, for the next run's reserve."""
    from .collect.audit import STATE

    try:
        state, opened = _merge_open(store)
        if not isinstance(opened, dict):
            return
        began, now = opened.get("clock"), budget.clock()
        if isinstance(began, (int, float)) and budget.start <= began <= now:
            took = round(now - began, 1)
            state["last_merge_to_publish_s"] = took
            log.info("run: %.0f min from the audit merge to the end of publish; the next run keeps at least %.0f min "
                     "back", took / 60, max(MIN_RESERVE_SEC, RESERVE_FACTOR * took) / 60)
        store.write_json(STATE, state)
    except Exception as exc:
        log.warning("run: couldn't record the merge-to-publish time in %s (%s)", STATE, exc)


def _close_merge(store):
    """Drop this run's `merge_open` when it ended without publishing (an error, or no publish step)."""
    try:
        state, opened = _merge_open(store)
        if opened is not None:
            from .collect.audit import STATE

            store.write_json(STATE, state)
    except Exception as exc:
        log.warning("run: couldn't tidy the audit state (%s)", exc)


def _audit_seen(store):
    """Where the audit load had got to as a process step starts. The step curates what was merged by then, so a
    publish that carries its output puts that history in the reports. None when the state can't be read."""
    from .collect.audit import SEEN, STATE

    try:
        state = store.read_json(STATE, {}) or {}
    except Exception as exc:
        log.warning("process: couldn't read the audit load's progress in %s (%s); status keeps what the last "
                    "publish carried", STATE, exc)
        return None
    return dict({k: state[k] for k in SEEN if state.get(k) is not None},
                process_started_at=datetime.now(timezone.utc).isoformat())


def _audit_processed(store):
    """What the last process step to finish had seen as it started (see `_audit_seen`), or None."""
    from .collect.audit import STATE

    try:
        processed = (store.read_json(STATE, {}) or {}).get("processed")
    except Exception as exc:
        log.warning("publish: couldn't read %s (%s); status keeps what the last publish carried", STATE, exc)
        return None
    return processed if isinstance(processed, dict) else None


def _record_audit(store, name, value):
    """Set `name` in the audit state. Left unset, `status` reads less as in the reports, never more."""
    from .collect.audit import STATE

    try:
        state = store.read_json(STATE, {}) or {}
        state[name] = value
        store.write_json(STATE, state)
    except Exception as exc:
        log.warning("run: couldn't record %s in %s (%s)", name, STATE, exc)


def q_lit(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _month_file(prefix: str, key: str) -> str:
    return f"{prefix}/month-{key.replace('-', '')}.parquet"


def _file_month(rel: str):
    m = re.fullmatch(r"month-(?:(\d{4})(\d{2})|(none))\.parquet", rel.rsplit("/", 1)[-1])
    if not m:
        return None
    return NULL_MONTH if m.group(3) else f"{m.group(1)}-{m.group(2)}"


def _core_logic_hash() -> str:
    # Any change to valuelens_core can change every curated month, so it forces a full rebuild.
    import valuelens_core

    root = Path(valuelens_core.__file__).parent
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    return digest.hexdigest()


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def process(store, *, exclude_agent_identities=True, include_raw_passthrough=False,
            full_rebuild=False, lookback_days=DEFAULT_INCREMENTAL_LOOKBACK_DAYS,
            max_rows_per_pass=DEFAULT_PROCESS_PASS_ROWS) -> int:
    """Curate interactions into one Parquet file per month, recomputing only what changed.

    A month is recomputed when its parsed rows changed (row count + row hash) or it lies in the
    lookback window before the newest record (late-arriving audit data). A recomputed month is
    curated from all of its source rows, so it equals a full rebuild; the kept months supply the
    history-wide context (schema-GUID agent links, Agent Last Used Date). Changed thread/message
    values also propagate to their historical rows, preserving unrelated snapshot values.
    New settings, new core
    logic, a new source schema, the legacy single-file layout or `full_rebuild` rebuild everything.

    Months holding more than `max_rows_per_pass` source rows in total are curated in passes of whole
    months, oldest first (0: one pass). Each pass sees the history as nightly runs would have built it:
    the kept months and the earlier passes, not the later ones. The state is saved after every pass,
    so a run stopped part-way resumes with the months still to do.
    Returns the curated row count across all months.
    """
    for prefix in PROCESS_INPUTS:
        store.pull(prefix)
    interactions = parquet_glob(store.root, PROCESS_INPUTS[0])
    if not interactions:
        log.warning("process: no Copilot interactions collected yet; nothing to curate")
        return 0
    with tempfile.TemporaryDirectory(prefix="valuelens-duckdb-") as spill:
        con = duckdb.connect()
        try:
            return _process(con, store, interactions, spill, exclude_agent_identities,
                            include_raw_passthrough, full_rebuild, lookback_days, max_rows_per_pass)
        finally:
            con.close()


def _process(con, store, interactions, spill, exclude_agent_identities, include_raw_passthrough,
             full_rebuild, lookback_days, max_rows_per_pass) -> int:
    con.execute("SET TimeZone = 'UTC'")
    # Spill to local disk instead of failing when a large history doesn't fit in memory.
    con.execute(f"SET temp_directory = {q(spill)}")
    if os.environ.get("VALUELENS_DUCKDB_MEMORY_LIMIT"):
        con.execute(f"SET memory_limit = {q(os.environ['VALUELENS_DUCKDB_MEMORY_LIMIT'])}")

    ts = creation_timestamp_sql(con, interactions) or "CAST(NULL AS TIMESTAMP)"
    month = f"coalesce(strftime(CAST({ts} AS DATE), '%Y-%m'), '{NULL_MONTH}')"
    source_months, max_creation = {}, None
    for key, n, h, mx in con.execute(
            f"SELECT {month} AS k, count(*), sum(hash(t)::HUGEINT), max({ts}) "
            f"FROM {interactions} t GROUP BY k").fetchall():
        source_months[key] = f"{n}:{h}"
        if mx is not None and (max_creation is None or mx > max_creation):
            max_creation = mx
    schema = con.sql(f"SELECT * FROM {interactions} LIMIT 0")
    config = processor_config_fingerprint({
        "core": _core_logic_hash(),
        "exclude_agent_identities": bool(exclude_agent_identities),
        "include_raw_passthrough": bool(include_raw_passthrough),
        "source_columns": [f"{c}:{t}" for c, t in zip(schema.columns, schema.types)],
    })

    saved = store.read_json(PROCESS_STATE)
    state = parse_processor_state(json.dumps(saved)) if saved else None
    curated_files = {_file_month(r): r for r in store.list(CURATED_PREFIX) if _file_month(r)}
    context_files = {_file_month(r): r for r in store.list(PROCESS_CONTEXT) if _file_month(r)}
    ready = (CURATED_LEGACY not in store.list(CURATED_PREFIX) and state is not None
             and all(k in curated_files and k in context_files for k in state["months"]))
    plan = plan_incremental_months(source_months, state, config, max_creation=max_creation,
                                   lookback_days=lookback_days, force_full=full_rebuild,
                                   target_ready=ready)
    months = plan["months"]
    log.info("process: %s %s; %s month(s) to curate: %s", "full rebuild" if plan["full"] else "incremental",
             f"({plan['reason']})", len(months), ", ".join(months) or "none")
    rows = dict((saved or {}).get("rows") or {}) if not plan["full"] else {}

    compute = [k for k in months if k in source_months]
    # Curated months without source rows give way: the plan's vanished months, and any a stopped run left.
    vanished = sorted({k for k in months if k not in source_months}
                      | {k for k in curated_files if k not in source_months})
    # Months that left the source (a full rebuild's old files included) and the legacy single file.
    stale = {r for files in (curated_files, context_files) for k, r in files.items() if k not in source_months}
    if CURATED_LEGACY in store.list(CURATED_PREFIX):
        stale.add(CURATED_LEGACY)
    passes = _passes(compute, source_months, max_rows_per_pass)
    if len(passes) > 1:
        log.info("process: %s source rows to curate in %s passes of up to %s rows, oldest first: %s",
                 sum(_source_rows(source_months[k]) for k in compute), len(passes), max_rows_per_pass,
                 "; ".join(", ".join(p) for p in passes))
    # Only the inputs were pulled: on Azure each run starts with an empty local copy, in a new container.
    # So a pass pulls the month files it reads just before reading them, each once a run; the files this
    # run wrote are local already. A full rebuild reads none of the history, so it pulls none of it.
    local = set()

    def fetch(rels):
        for rel in rels:
            if rel not in local:
                store.pull(rel)
                local.add(rel)

    done, wrote = set(), set()
    for i, part in enumerate(passes):
        later = {k for p in passes[i + 1:] for k in p}
        # A pass sees the history as nightly runs would have built it: the kept months and the earlier
        # passes. The later passes' months stay hidden, and on a full rebuild so do this pass's old files.
        hidden = later | (set(part) if plan["full"] else set())
        written, counts = _curate_months(
            con, store, interactions, month, compute=part, replaced=part + (vanished if i == 0 else []),
            incremental=not plan["full"] or i > 0,
            curated=[r for k, r in curated_files.items() if k not in hidden],
            context=[context_files[k] for k in source_months
                     if k in context_files and (k not in months or k in done)], fetch=fetch,
            exclude_agent_identities=exclude_agent_identities, include_raw_passthrough=include_raw_passthrough)
        store.push(written)
        local.update(written)
        if i == 0 and stale:
            store.remove(sorted(stale))
            curated_files = {k: r for k, r in curated_files.items() if r not in stale}
            context_files = {k: r for k, r in context_files.items() if r not in stale}
        done.update(part)
        wrote.update(counts)
        rows.update(counts)
        for key in counts:
            curated_files[key] = _month_file(CURATED_PREFIX, key)
            context_files[key] = _month_file(PROCESS_CONTEXT, key)
        rows = {k: v for k, v in rows.items() if k in source_months}
        # Saved after every pass: a run stopped part-way finds the later months missing and curates them.
        finished = {k: v for k, v in source_months.items() if k not in later}
        store.write_json(PROCESS_STATE, {**json.loads(build_processor_state(config, finished)),
                                         "rows": {k: v for k, v in rows.items() if k in finished}})
        if len(passes) > 1:
            log.info("process: pass %s of %s done; wrote %s", i + 1, len(passes), ", ".join(sorted(counts)) or "nothing")
    total = sum(int(v) for v in rows.values())
    log.info("process: wrote %s month(s), including conversation dependencies; %s curated rows in total",
             len(wrote), total)
    return total


def _source_rows(fingerprint: str) -> int:
    return int(str(fingerprint).split(":", 1)[0])


def _passes(compute, source_months, max_rows):
    """Split the months to curate into passes of up to `max_rows` source rows, in order.

    A month is never split, so a month above the budget is a pass of its own. Within the budget, or with
    `max_rows` <= 0, it is one pass, as before. Always at least one pass, which may be empty."""
    passes, size = [[]], 0
    for key in compute:
        n = _source_rows(source_months[key])
        if max_rows > 0 and passes[-1] and size + n > max_rows:
            passes.append([])
            size = 0
        passes[-1].append(key)
        size += n
    return passes


# One pass's working views and tables, views first. A pass drops them all, so the next starts empty.
_PASS_OBJECTS = (("VIEW", "__vl_write"), ("VIEW", "__vl_updated_rows"), ("VIEW", "__vl_current"),
                 ("VIEW", "__vl_kept"), ("VIEW", "__vl_previous"), ("TABLE", "__vl_updated"),
                 ("TABLE", "__vl_changed"), ("TABLE", "__vl_complete_out"), ("TABLE", "__vl_process_out"))
# What writing the months reads. The rest of a pass's objects go before the writes start.
_WRITE_INPUTS = {"__vl_write", "__vl_changed", "__vl_complete_out", "__vl_process_out"}


def _drop(con, objects):
    for kind, name in objects:
        con.execute(f"DROP {kind} IF EXISTS {name}")


def _curate_months(con, store, interactions, month, *, compute, replaced, incremental, curated, context, fetch,
                   exclude_agent_identities, include_raw_passthrough):
    """Curate the `compute` months, then write them and the other months whose conversation values changed.

    `replaced` lists the months whose earlier rows give way (`compute`, and months that left the source).
    `curated` lists the month files of the history the pass sees, and `context` the context files of the
    months it sees but doesn't curate. `fetch` makes the files it is given local, and is called with the
    files just before they're read. Returns the files written and the row count of each month written.
    """
    written, rows = [], {}
    write_months = set(compute)
    if compute:
        fetch(context)
        context_rel = (con.sql(f"SELECT * FROM read_parquet([{', '.join(q(store.path(r)) for r in context)}], "
                               f"union_by_name=true)") if context else None)
        src = con.sql(f"SELECT * FROM {interactions} t WHERE {month} IN ({', '.join(q_lit(k) for k in compute)})")
        curate(con, src, parquet_glob(store.root, PROCESS_INPUTS[1]), parquet_glob(store.root, PROCESS_INPUTS[2]),
               exclude_agent_identities=exclude_agent_identities, include_raw_passthrough=include_raw_passthrough,
               context=context_rel, output="__vl_process_out")
    incremental = incremental and bool(replaced)
    if incremental:
        if curated:
            fetch(curated)
            old_paths = ", ".join(q(store.path(r)) for r in curated)
            con.execute(f"CREATE TEMP VIEW __vl_previous AS SELECT * FROM read_parquet([{old_paths}], "
                        "union_by_name=true)")
        else:
            # The first pass of a backfill can come before every month curated so far.
            con.execute("CREATE TEMP VIEW __vl_previous AS SELECT * FROM __vl_process_out WHERE FALSE")
        if not compute:
            con.execute("CREATE TEMP TABLE __vl_process_out AS SELECT * FROM __vl_previous WHERE FALSE")
        changed_months = ", ".join(q_lit(k) for k in replaced)
        old_month = f"coalesce(strftime(MonthStart, '%Y-%m'), '{NULL_MONTH}')"
        kept = f"{old_month} NOT IN ({changed_months})"
        con.execute(f"CREATE TEMP VIEW __vl_kept AS SELECT ThreadId, Message_Id FROM __vl_previous WHERE {kept}")
        # Only conversations that reach a kept month can change values there. The other replaced and
        # curated rows already hold values computed over their whole conversation, so they skip the update.
        con.execute("CREATE TEMP TABLE __vl_changed AS SELECT ThreadId, Message_Id FROM ("
                    f"SELECT ThreadId, Message_Id FROM __vl_previous WHERE NOT ({kept}) UNION ALL "
                    "SELECT ThreadId, Message_Id FROM __vl_process_out) AS c "
                    f"WHERE {conversation_predicate_sql('__vl_kept', 'ThreadId', 'c')} "
                    f"OR {conversation_predicate_sql('__vl_kept', 'Message_Id', 'c')}")
        con.execute(f"CREATE TEMP VIEW __vl_current AS SELECT * FROM __vl_previous WHERE {kept} "
                    "UNION ALL BY NAME SELECT * FROM __vl_process_out")
        updated, dirty_months = update_conversations(con, "__vl_current", "__vl_changed", output="__vl_updated")
        updated.create_view("__vl_updated_rows")
        write_months.update(value.strftime("%Y-%m") if value is not None else NULL_MONTH for value in dirty_months)
        if write_months:
            targets = ", ".join(q_lit(k) for k in sorted(write_months))
            thread = conversation_predicate_sql("__vl_changed", "ThreadId")
            message = conversation_predicate_sql("__vl_changed", "Message_Id")
            unchanged = f"{old_month} IN ({targets}) AND NOT ({thread} OR {message})"
            # Materialise before replacing any input file: later months must not read a
            # mixture of old and already-updated Parquet files from this same run.
            con.execute("CREATE TEMP TABLE __vl_complete_out AS "
                        f"SELECT * FROM __vl_updated_rows WHERE {old_month} IN ({targets}) UNION ALL BY NAME "
                        f"SELECT * FROM __vl_previous r WHERE {kept} AND {unchanged}")
            # The curated rows are a table already, so the write reads them there instead of copying them.
            con.execute("CREATE TEMP VIEW __vl_write AS SELECT * FROM __vl_complete_out UNION ALL BY NAME "
                        f"SELECT * FROM __vl_process_out r WHERE {unchanged}")
            # Only the rows to write are needed from here on; freeing the rest spares spilling it.
            _drop(con, [o for o in _PASS_OBJECTS if o[1] not in _WRITE_INPUTS])
    output = "__vl_write" if incremental else "__vl_process_out"
    for key in sorted(write_months):
        where = ("MonthStart IS NULL" if key == NULL_MONTH
                 else f"strftime(MonthStart, '%Y-%m') = {q_lit(key)}")
        for rel, sql in (
                (_month_file(CURATED_PREFIX, key), f"SELECT * FROM {output} WHERE {where}"),
                # Enough of the month for later runs' history-wide values, without re-reading it.
                (_month_file(PROCESS_CONTEXT, key),
                 f"SELECT AgentId, AgentName, max(CreationDate) AS CreationDate FROM {output} "
                 f"WHERE {where} AND (AgentId IS NOT NULL OR AgentName IS NOT NULL) "
                 f"GROUP BY AgentId, AgentName")):
            target = store.path(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".tmp")
            con.execute(f"COPY ({sql}) TO {q(tmp)} (FORMAT PARQUET)")
            tmp.replace(target)
            written.append(rel)
        rows[key] = con.execute(f"SELECT count(*) FROM {output} WHERE {where}").fetchone()[0]
    _drop(con, _PASS_OBJECTS)
    return written, rows


def _api(settings):
    from .api import Api, TokenSource

    return Api(TokenSource())


def collect(store, settings, api=None, *, budget=None) -> dict:
    """Run every selected collector. One failing source doesn't stop the others (or the publish that
    follows); failures are returned under ``errors`` and fail the job once the remaining steps finish.

    The audit collector runs last, so a slow or throttled history fetch never keeps the other sources from
    running. With `budget` it fetches until the run's time budget, counted from the job's start, so the time the
    other collectors take shortens it; then it pauses, and the next run carries on.
    """
    from .collect.audit import collect_audit
    from .collect.audit import remember_backfill as remember_audit_backfill
    from .collect.graph import collect_licensed, collect_m365, collect_org

    api = api or _api(settings)
    clock = budget.clock if budget is not None else time.monotonic
    jobs = []
    if settings.has("core"):
        jobs.append(("licensed", collect_licensed))
        try:
            # Before any collector runs: a reload this run stops short of is then read by the next runs.
            remember_audit_backfill(store, settings)
        except Exception as exc:
            log.warning("collect audit: couldn't remember the reload for later runs: %s", exc)
    if settings.has("orgData"):
        jobs.append(("org", collect_org))
        if settings.has("workday"):
            # After org, whatever its outcome, as the Fabric pipeline runs the Workday notebook.
            from .collect.workday import collect_workday

            jobs.append(("workday", collect_workday))
    if settings.has("m365Activity"):
        jobs.append(("m365", collect_m365))
    if settings.has("defender"):
        from .collect.defender import collect_defender

        jobs.append(("defender", collect_defender))
    if settings.has("consumption"):
        from .collect.studio import collect_studio
        from .collect.viva import collect_viva

        jobs += [("studio", collect_studio), ("viva", collect_viva)]
        if settings.azure_ai_subscription:
            from .collect.azure_ai import collect_azure_ai

            jobs.append(("azure_ai", collect_azure_ai))
        else:
            # As in Fabric: without the Azure AI subscription, Copilot pay-as-you-go isn't read either.
            log.info("collect azure_ai: VALUELENS_AZURE_AI_SUBSCRIPTION not set; Azure AI and PAYG skipped")
    if settings.has("agent365"):
        # Before resource_graph, which maps agents to their Agent 365 titles through this table.
        from .collect.agent365 import collect_agent365

        jobs.append(("agent365", collect_agent365))
    if settings.has("productFeedback"):
        from .collect.product_feedback import collect_product_feedback

        jobs.append(("product_feedback", collect_product_feedback))
    if settings.has("resourceGraph"):
        from .collect.resource_graph import collect_resource_graph

        jobs.append(("resource_graph", collect_resource_graph))
    if settings.has("agentEvaluator"):
        if settings.dataverse_environments:
            from .collect.agent_evaluator import collect_agent_evaluator, remember_backfill

            try:
                # Before any collector runs: a reload this run stops short of is then read by the next runs.
                remember_backfill(store, settings)
            except Exception as exc:
                log.warning("collect agent_evaluator: couldn't remember the reload for later runs: %s", exc)
            jobs.append(("agent_evaluator", collect_agent_evaluator))
        else:
            # The installer lists the environments once the managed identity can read one of them.
            log.info("collect agent_evaluator: VALUELENS_DATAVERSE_ENVIRONMENTS lists no environment yet; skipped")
    if settings.has("core"):
        # Last, so a slow or throttled history fetch never keeps the other sources from running. No other
        # collector reads what it writes; `process` does, after every collector.
        jobs.append(("audit", collect_audit))
    out, errors = {}, {}
    for name, fn in jobs:
        kwargs = {}
        if name == "audit" and budget is not None:
            kwargs = {"deadline": budget.fetch_deadline, "hard_deadline": budget.hard_deadline, "clock": clock}
            log.info("collect audit: fetching for up to %.0f min, until %.0f min after the job's start (%s); the "
                     "run's limit is %.0f min", max(budget.fetch_deadline - clock(), 0) / 60,
                     (budget.fetch_deadline - budget.start) / 60,
                     f"VALUELENS_AUDIT_TIME_BUDGET_MIN={budget.override_min:g}" if budget.override_min is not None
                     else f"{budget.reserve_s / 60:.0f} min kept back for merge, process, publish and refresh",
                     budget.timeout_s / 60)
        began = clock()
        try:
            out[name] = fn(api, store, settings, **kwargs)
        except Exception as exc:
            log.exception("collect %s failed: %s", name, exc)
            errors[name] = f"{type(exc).__name__}: {exc}"
        finally:
            log.info("collect %s: took %.1f min", name, (clock() - began) / 60)
    if errors:
        out["errors"] = errors
    return out


def publish_targets(settings) -> list[str]:
    from .publish import CONSUMPTION, DEFENDER, RESOURCE_GRAPH

    consumption = list(CONSUMPTION) if settings.has("consumption") else []
    if settings.has("resourceGraph") and not settings.sample_data:
        consumption += list(RESOURCE_GRAPH)
    if settings.sample_data:
        # The sample replaces the people, Copilot and consumption tables; tenant M365 activity is left as it is.
        return ["curated", "licensed", "org", *consumption]
    targets = []
    if settings.has("core"):
        targets += ["curated", "licensed"]
    if settings.has("orgData"):
        targets.append("org")
        if settings.has("workday"):
            from .collect.workday import writes_preview

            if writes_preview(settings):
                targets.append("copilot_org_data_workday_preview")
    if settings.has("m365Activity"):
        targets.append("m365")
    if settings.has("defender"):
        targets += list(DEFENDER)
    if settings.has("agent365"):
        targets.append("agents_365")
    if settings.has("productFeedback"):
        targets.append("user_feedback")
    if settings.has("agentEvaluator"):
        from .publish import AGENT_EVALUATOR

        targets += list(AGENT_EVALUATOR)
    return targets + consumption


def _sql(settings):
    from .api import TokenSource
    from .sql import connect

    if not settings.sql_server or not settings.sql_database:
        raise ValueError("VALUELENS_SQL_SERVER and VALUELENS_SQL_DATABASE must be set.")
    return connect(settings, TokenSource())


def publish_step(store, settings, conn=None):
    from .access import sync_access
    from .publish import publish

    conn = conn or _sql(settings)
    try:
        results = publish(conn, store, publish_targets(settings))
        try:
            access = sync_access(conn, store)
        except Exception as exc:
            # The scopes already in SQL stay as they were; the models still refresh.
            log.exception("access: sync failed: %s", exc)
            conn.rollback()
            access = {"error": f"{type(exc).__name__}: {exc}"}
        return results + [{"table": "access", **access}]
    finally:
        conn.close()


def access_step(store, settings, conn=None):
    from .access import sync_access

    conn = conn or _sql(settings)
    try:
        return sync_access(conn, store)
    finally:
        conn.close()


def migrate_step(settings, conn=None, folder=None):
    from .sql import default_migrations_dir, ensure_reader, migrate

    folder = folder or os.environ.get("VALUELENS_MIGRATIONS_DIR") or default_migrations_dir()
    conn = conn or _sql(settings)
    try:
        ran = migrate(conn, folder)
        ensure_reader(conn, settings.sql_reader_name, settings.sql_reader_client_id)
        return ran
    finally:
        conn.close()


def refresh_step(settings, api=None, publish_results=None, today=None, store=None, deadline=None, clock=None):
    """Refresh the models. `deadline` (a reading of `clock`) caps the waits; with `store`, a full refresh this run
    can't finish stays owed to the next run that has the store (see refresh.refresh_models)."""
    from datetime import date

    from .refresh import needs_full_refresh, refresh_models

    all_partitions = needs_full_refresh(publish_results, today or date.today())
    extra = {k: v for k, v in (("store", store), ("deadline", deadline), ("clock", clock)) if v is not None}
    return refresh_models(api or _api(settings), settings, all_partitions=all_partitions, **extra)


def main(argv=None, env=None, clock=time.monotonic) -> int:
    # The run's time budget counts from here (see run_budget).
    started = clock()
    logging.basicConfig(level=os.environ.get("VALUELENS_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # The Azure SDK logs every HTTP request and response at INFO, which buries the job's own lines.
    logging.getLogger("azure").setLevel(os.environ.get("VALUELENS_AZURE_LOG_LEVEL", "WARNING"))
    ap =  argparse.ArgumentParser(prog="valuelens_jobs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run")
    run.add_argument("--steps", default=",".join(DEFAULT_STEPS))
    run.add_argument("--data-dir", default=os.environ.get("VALUELENS_DATA_DIR"))
    proc = sub.add_parser("process")
    proc.add_argument("--data-dir", required=True)
    proc.add_argument("--keep-agent-identities", action="store_true")
    proc.add_argument("--raw-passthrough", action="store_true")
    proc.add_argument("--full-rebuild", action="store_true",
                      help="recompute every month instead of only the changed ones")
    sub.add_parser("migrate")
    args = ap.parse_args(argv)
    settings = Settings.from_env(env)
    log.info("valuelens-jobs %s; modules: %s", settings.version or "dev", ",".join(sorted(settings.modules)))
    environ = os.environ if env is None else env
    process_options = {
        "full_rebuild": _truthy(environ.get("VALUELENS_PROCESS_FULL_REBUILD")),
        "lookback_days": int(environ.get("VALUELENS_PROCESS_LOOKBACK_DAYS") or DEFAULT_INCREMENTAL_LOOKBACK_DAYS),
        "max_rows_per_pass": int(environ.get("VALUELENS_PROCESS_PASS_ROWS") or DEFAULT_PROCESS_PASS_ROWS),
    }

    if args.cmd == "process":
        store = LocalStore(args.data_dir)
        try:
            lock = runlock.take(store, environ, settings, ["process"])
        except LeaseHeld as held:
            return runlock.stopped(held, ["process"], settings)
        try:
            process(store, exclude_agent_identities=not args.keep_agent_identities,
                    include_raw_passthrough=args.raw_passthrough,
                    **{**process_options, "full_rebuild": args.full_rebuild or process_options["full_rebuild"]})
        finally:
            if lock is not None:
                lock.release()
        return 0
    if args.cmd == "migrate":
        # No run lock: migrate doesn't open the store, and an install or update mustn't skip it.
        migrate_step(settings)
        return 0
    steps = [s.strip() for s in args.steps.split(",") if s.strip()]
    unknown = [s for s in steps if s not in STEPS]
    if unknown:
        ap.error(f"unknown steps {unknown}; expected a subset of {list(STEPS)}")
    store = open_store(args.data_dir, settings) if {"collect", "process", "publish", "access"} & set(steps) else None
    # One run at a time (see runlock): a run that opens the store holds the run lock until it ends, and one that
    # finds it held stops here. A refresh-only run has no store or state of its own, and Power BI waits while
    # another refresh is going. A sample run holds it too, as it publishes to the same database.
    lock = None
    if store is not None:
        try:
            lock = runlock.take(store, environ, settings, steps)
        except LeaseHeld as held:
            return runlock.stopped(held, steps, settings)
    collect_errors = {}
    audit = published = next_run = None
    collects = recorded = False
    released = True
    try:
        if store is not None and settings.sample_data:
            import tempfile

            # A throwaway store, so the tenant's collected data in Storage is neither read nor changed.
            store = LocalStore(tempfile.mkdtemp(prefix="valuelens-sample-"))
            log.warning("VALUELENS_SAMPLE_DATA is on: publishing the synthetic sample instead of tenant data")
        # The tenant's own data: not a sample run's throwaway store.
        tenant = store is not None and not settings.sample_data
        collects = "collect" in steps and tenant
        budget = run_budget(store if tenant and {"collect", "process"} & set(steps) else None, environ,
                            start=started, clock=clock, settle=collects)
        for step in STEPS:
            if step not in steps:
                continue
            log.info("step %s: start", step)
            if step == "collect":
                if settings.sample_data:
                    from .sample import load

                    load(store, consumption=settings.has("consumption"))
                else:
                    out = collect(store, settings, budget=budget)
                    collect_errors, audit = out.get("errors", {}), out.get("audit")
            elif step == "process":
                full = _start_owed_rebuild(store, budget, process_options["full_rebuild"]) if tenant \
                    else process_options["full_rebuild"]
                seen = _audit_seen(store) if tenant else None
                process(store, **{**process_options, "full_rebuild": full})
                if seen is not None:
                    _record_audit(store, "processed", seen)
            elif step == "publish":
                # The last process step to finish had curated what was merged when it started, so this publish
                # carries at least that, also in a run that publishes without processing.
                carried = _audit_processed(store) if tenant else None
                published = publish_step(store, settings)
                if collects:
                    _record_merge_to_publish(store, budget)
                    recorded = True
                if carried is not None:
                    _record_audit(store, "published",
                                  dict(carried, published_at=datetime.now(timezone.utc).isoformat()))
            elif step == "access":
                if "publish" not in steps:
                    access_step(store, settings)
            else:
                # Only a run that publishes carries an owed full refresh: an `access,refresh` run stays
                # incremental, so it fits the installer's wait, and a refresh-only run has no store.
                owed = {"store": store} if tenant and "publish" in steps else {}
                refresh_step(settings, publish_results=published, deadline=budget.refresh_deadline,
                             clock=budget.clock, **owed)
            log.info("step %s: done", step)
        if collects and not collect_errors:
            # Counted while this run holds the run lock; started once it's released (see continue_run).
            next_run = continue_run.decide(store, environ, audit)
    finally:
        try:
            if collects and not recorded:
                _close_merge(store)
        finally:
            if lock is not None:
                released = lock.release()
    # The run lock is released: what follows runs without it.
    if collect_errors:
        raise RuntimeError("the run published what it collected, but these sources failed and resume next run: "
                           + "; ".join(f"{k}: {v}" for k, v in collect_errors.items()))
    if next_run:
        # A lock that couldn't be released lapses within LEASE_SEC: the next run would stop behind it before then.
        continue_run.start(next_run, wait=0 if released else runlock.LEASE_SEC)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # one clear line in the Container Apps log, then non-zero exit
        log.exception("valuelens-jobs failed: %s", exc)
        sys.exit(1)
