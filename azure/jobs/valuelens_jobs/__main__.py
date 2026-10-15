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
    raw/copilot_org_data/part-0.parquet
    raw/m365_activity_daily/day-YYYYMMDD.parquet
    raw/defender_*/...                                         (module defender, optional)
    landing/defender/ai_watchlist.csv                          (module defender: the AI watchlist, admin-edited)
    raw/agents_365/*.parquet                                   (Phase 2, optional)
    curated/copilot_interactions_curated/month-YYYYMM.parquet  (one file per month; month-none = no date)
    curated/_valuelens_process/state.json, context/            (incremental process bookkeeping)
    curated/<studio_* | viva_*>/part-0.parquet                 (module consumption, merged state)
    raw/<azure_ai_* | copilot_payg_spend | ...>/part-0.parquet (module consumption, Azure AI)
    landing/studio/*.csv, landing/viva/*.csv                   (consumption drop folder, read only)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
from pathlib import Path

import duckdb

from valuelens_core import creation_timestamp_sql, curate
from valuelens_core.incremental import (DEFAULT_INCREMENTAL_LOOKBACK_DAYS, NULL_MONTH, build_processor_state,
                                        parse_processor_state, plan_incremental_months,
                                        processor_config_fingerprint)

from .config import Settings
from .storage import LocalStore, open_store
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
            full_rebuild=False, lookback_days=DEFAULT_INCREMENTAL_LOOKBACK_DAYS) -> int:
    """Curate interactions into one Parquet file per month, recomputing only what changed.

    A month is recomputed when its parsed rows changed (row count + row hash) or it lies in the
    lookback window before the newest record (late-arriving audit data). A recomputed month is
    curated from all of its source rows, so it equals a full rebuild; the kept months supply the
    history-wide context (schema-GUID agent links, Agent Last Used Date). New settings, new core
    logic, a new source schema, the legacy single-file layout or `full_rebuild` rebuild everything.
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
                            include_raw_passthrough, full_rebuild, lookback_days)
        finally:
            con.close()


def _process(con, store, interactions, spill, exclude_agent_identities, include_raw_passthrough,
             full_rebuild, lookback_days) -> int:
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
    written, removed = [], []
    if compute:
        keep = [context_files[k] for k in source_months if k not in months and k in context_files]
        context = (con.sql(f"SELECT * FROM read_parquet([{', '.join(q(store.path(r)) for r in keep)}], "
                           f"union_by_name=true)") if keep else None)
        src = con.sql(f"SELECT * FROM {interactions} t WHERE {month} IN ({', '.join(q_lit(k) for k in compute)})")
        curate(con, src, parquet_glob(store.root, PROCESS_INPUTS[1]), parquet_glob(store.root, PROCESS_INPUTS[2]),
               exclude_agent_identities=exclude_agent_identities, include_raw_passthrough=include_raw_passthrough,
               context=context, output="__vl_process_out")
        for key in compute:
            where = ("MonthStart IS NULL" if key == NULL_MONTH
                     else f"strftime(MonthStart, '%Y-%m') = {q_lit(key)}")
            for rel, sql in (
                    (_month_file(CURATED_PREFIX, key), f"SELECT * FROM __vl_process_out WHERE {where}"),
                    # Enough of the month for later runs' history-wide values, without re-reading it.
                    (_month_file(PROCESS_CONTEXT, key),
                     f"SELECT AgentId, AgentName, max(CreationDate) AS CreationDate FROM __vl_process_out "
                     f"WHERE {where} AND (AgentId IS NOT NULL OR AgentName IS NOT NULL) "
                     f"GROUP BY AgentId, AgentName")):
                target = store.path(rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                tmp = target.with_suffix(".tmp")
                con.execute(f"COPY ({sql}) TO {q(tmp)} (FORMAT PARQUET)")
                tmp.replace(target)
                written.append(rel)
            rows[key] = con.execute(f"SELECT count(*) FROM __vl_process_out WHERE {where}").fetchone()[0]
        con.execute("DROP TABLE IF EXISTS __vl_process_out")
    store.push(written)
    # Months that left the source (a full rebuild's old files included) and the legacy single file.
    stale = [r for files in (curated_files, context_files) for k, r in files.items() if k not in source_months]
    if CURATED_LEGACY in store.list(CURATED_PREFIX):
        stale.append(CURATED_LEGACY)
    if stale:
        store.remove(sorted(set(stale)))
    rows = {k: v for k, v in rows.items() if k in source_months}
    store.write_json(PROCESS_STATE, {**json.loads(build_processor_state(config, source_months)), "rows": rows})
    total = sum(int(v) for v in rows.values())
    log.info("process: wrote %s month(s); %s curated rows in total", len(compute), total)
    return total


def _api(settings):
    from .api import Api, TokenSource

    return Api(TokenSource())


def collect(store, settings, api=None) -> dict:
    """Run every selected collector. One failing source doesn't stop the others (or the publish that
    follows); failures are returned under ``errors`` and fail the job once the remaining steps finish."""
    from .collect.audit import collect_audit
    from .collect.graph import collect_licensed, collect_m365, collect_org

    api = api or _api(settings)
    jobs = []
    if settings.has("core"):
        jobs += [("licensed", collect_licensed), ("audit", collect_audit)]
    if settings.has("orgData"):
        jobs.append(("org", collect_org))
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
    if settings.has("resourceGraph"):
        from .collect.resource_graph import collect_resource_graph

        jobs.append(("resource_graph", collect_resource_graph))
    out, errors = {}, {}
    for name, fn in jobs:
        try:
            out[name] = fn(api, store, settings)
        except Exception as exc:
            log.exception("collect %s failed: %s", name, exc)
            errors[name] = f"{type(exc).__name__}: {exc}"
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
    if settings.has("m365Activity"):
        targets.append("m365")
    if settings.has("defender"):
        targets += list(DEFENDER)
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


def refresh_step(settings, api=None, publish_results=None, today=None):
    from datetime import date

    from .refresh import needs_full_refresh, refresh_models

    all_partitions = needs_full_refresh(publish_results, today or date.today())
    return refresh_models(api or _api(settings), settings, all_partitions=all_partitions)


def main(argv=None, env=None) -> int:
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
    }

    if args.cmd == "process":
        process(LocalStore(args.data_dir), exclude_agent_identities=not args.keep_agent_identities,
                include_raw_passthrough=args.raw_passthrough,
                **{**process_options, "full_rebuild": args.full_rebuild or process_options["full_rebuild"]})
        return 0
    if args.cmd == "migrate":
        migrate_step(settings)
        return 0
    steps = [s.strip() for s in args.steps.split(",") if s.strip()]
    unknown = [s for s in steps if s not in STEPS]
    if unknown:
        ap.error(f"unknown steps {unknown}; expected a subset of {list(STEPS)}")
    store = open_store(args.data_dir, settings) if {"collect", "process", "publish", "access"} & set(steps) else None
    if store is not None and settings.sample_data:
        import tempfile

        # A throwaway store, so the tenant's collected data in Storage is neither read nor changed.
        store = LocalStore(tempfile.mkdtemp(prefix="valuelens-sample-"))
        log.warning("VALUELENS_SAMPLE_DATA is on: publishing the synthetic sample instead of tenant data")
    collect_errors = {}
    published = None
    for step in STEPS:
        if step not in steps:
            continue
        log.info("step %s: start", step)
        if step == "collect":
            if settings.sample_data:
                from .sample import load

                load(store, consumption=settings.has("consumption"))
            else:
                collect_errors = collect(store, settings).get("errors", {})
        elif step == "process":
            process(store, **process_options)
        elif step == "publish":
            published = publish_step(store, settings)
        elif step == "access":
            if "publish" not in steps:
                access_step(store, settings)
        else:
            refresh_step(settings, publish_results=published)
        log.info("step %s: done", step)
    if collect_errors:
        raise RuntimeError("the run published what it collected, but these sources failed and resume next run: "
                           + "; ".join(f"{k}: {v}" for k, v in collect_errors.items()))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # one clear line in the Container Apps log, then non-zero exit
        log.exception("valuelens-jobs failed: %s", exc)
        sys.exit(1)
