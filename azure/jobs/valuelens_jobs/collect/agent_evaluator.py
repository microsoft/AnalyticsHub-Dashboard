"""Agent Evaluator (module `agentEvaluator`): Copilot Studio conversation transcripts from Dataverse.

The Azure port of the Fabric parser notebook (fabric/notebooks/agent-evaluator/
Copilot_Agent_Transcript_Parser.ipynb). The jobs' managed identity reads each environment's
`conversationtranscripts` (it's an application user there with the Bot Transcript Viewer role) in parallel
date windows, following nextLink pages; `Api` retries throttling (429, honouring Retry-After) and transient
errors. Worker processes parse the transcripts (valuelens_jobs.transcripts) and the rows are merged into month
files, keyed on the transcript and its environment:

    raw/agent_sessions/month-YYYYMM.parquet     also agent_turns, agent_errors, agent_subagents and
                                                agent_performance; the month the conversation started (UTC),
                                                month-none when it has no start time
    raw/agent_catalogue/part-0.parquet          one row per agent, rebuilt from every session each run
    raw/evaluator_status/part-0.parquet         one row per environment: what the latest run read
    raw/_state/agent_evaluator.json             when each environment was last read completely

Each run reads the lookback (VALUELENS_TRANSCRIPT_LOOKBACK_DAYS), stretched to cover any gap since the
environment's last complete read; an environment no run has read completely goes back
VALUELENS_TRANSCRIPT_FIRST_READ_DAYS. A transcript read again replaces all of its rows. The raw transcript
`content` is never written anywhere: it's parsed in memory, and only the parsed rows (with 500-character text
previews, as in Fabric) are spooled to a temporary folder before the merge.
"""
from __future__ import annotations

import logging
import multiprocessing
import os
import queue
import re
import tempfile
import threading
from collections import deque
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit

import duckdb

from .. import transcripts as tx
from ..api import HttpError, raise_for_status
from ..tables import ident, q, write_rows

log = logging.getLogger("valuelens_jobs.collect.agent_evaluator")

STATE = "raw/_state/agent_evaluator.json"
CATALOGUE = "raw/agent_catalogue/part-0.parquet"
STATUS = "raw/evaluator_status/part-0.parquet"
PARSE_CHUNK = 200  # transcripts per parse task, as the notebook's PARSE_CHUNK_ROWS
REQUEST_TIMEOUT = 180
GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
MONTH_FILE = re.compile(r"month-(\d{6}|none)\.parquet")
MONTH = "coalesce(strftime(transcript_date, '%Y%m'), 'none')"
# Read in full every run: is_returning_user and the catalogue need every transcript. The other tables only
# load the months the run's transcripts fall in.
FULL_HISTORY = ("agent_sessions", "agent_subagents")
# Sessions go last, so a run that stops part-way never shows a session without its turns.
WRITE_ORDER = ("agent_turns", "agent_errors", "agent_performance", "agent_subagents", "agent_sessions")
# The merge's DuckDB memory cap unless VALUELENS_DUCKDB_MEMORY_LIMIT sets one; past it, DuckDB spills to disk.
# Half the jobs container's 8 GiB: DuckDB's own default is 80% of the memory it sees, which can be the host's.
MERGE_MEMORY = "4GB"
IDS_PER_QUERY = 15
QUERIES_PER_BATCH = 20
BATCH_URL = "https://graph.microsoft.com/v1.0/$batch"


def prefix(table: str) -> str:
    return f"raw/{table}"


def _type(column: str) -> str:
    return "DATE" if column == "transcript_date" else "VARCHAR"


def _utc(now) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now if now.tzinfo else now.replace(tzinfo=timezone.utc)


# ------------------------------------------------------------------------------------------------- reading
def fetch_window(api, base: str, start, end, on_page, page_size: int = 1000) -> int:
    """Reads one environment's transcripts that started in [start, end) (ISO-Z strings, None = unbounded),
    handing each page to `on_page`, and returns how many it read. When the environment doesn't expose the bot
    lookup ($expand gets HTTP 400), the window starts again without it, keeping the date filter."""
    base = base.rstrip("/")
    flt = []
    if start:
        flt.append(f"conversationstarttime ge {start}")
    if end:
        flt.append(f"conversationstarttime lt {end}")
    filter_q = ("&$filter=" + " and ".join(flt)) if flt else ""
    root = f"{base}/api/data/v9.2/conversationtranscripts?$select={tx.SELECT}"
    url, expand = f"{root}&$expand={tx.EXPAND}{filter_q}", True
    headers = {"Accept": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0",
               "Prefer": f"odata.maxpagesize={int(page_size)}"}
    host = urlsplit(base).netloc or base
    count = 0
    while url:
        r = api.request("GET", url, scope=f"{base}/.default", headers=headers, timeout=REQUEST_TIMEOUT)
        if r.status_code == 400 and expand:
            log.info("  %s: no bot lookup on conversationtranscripts, so reading this window without it", host)
            url, expand = f"{root}{filter_q}", False
            continue
        if r.status_code in (401, 403):
            raise HttpError(f"Dataverse {host} returned HTTP {r.status_code}: the jobs' managed identity needs to be "
                            "an application user there with the Bot Transcript Viewer role (the installer's Repair "
                            f"or change adds it). {(getattr(r, 'text', '') or '')[:300]}".strip(), r.status_code)
        raise_for_status(r, f"Dataverse {host} conversationtranscripts")
        body = r.json()
        page = body.get("value") or []
        count += len(page)
        on_page(page)
        url = body.get("@odata.nextLink")
    return count


def _token_errors(api, urls) -> dict:
    """Gets each environment's token up front, one at a time, so a sign-in failure is clear and Entra isn't
    asked in parallel. Returns {url: error} for the environments that failed."""
    tokens = getattr(api, "tokens", None)
    bad = {}
    if tokens is None:
        return bad
    for url in urls:
        try:
            tokens.get(f"{url}/.default")
        except Exception as exc:  # noqa: BLE001 - recorded in evaluator_status
            bad[url] = exc
            log.warning("  %s skipped: couldn't get a token (%s)", url, exc)
    return bad


# ------------------------------------------------------------------------------------------------- parsing
def _workers(setting: int) -> int:
    if setting is not None and int(setting) >= 0:
        return int(setting)
    try:
        cpus = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        cpus = os.cpu_count() or 1
    return min(4, cpus)


class _Parser:
    """Parses staged transcripts PARSE_CHUNK at a time in worker processes (in this process with one worker or
    fewer, or when the workers fail) and appends each table's rows to `<folder>/<table>.jsonl.gz`.

    `put` is called from the reading threads and blocks while the queue is full, so reading never runs far
    ahead of parsing. After an error, `put` raises and the queue is drained; `close` returns the error."""

    def __init__(self, folder: Path, workers: int):
        self.folder = Path(folder)
        self.workers = max(0, int(workers))
        self.inline = self.workers <= 1
        self.counts = {t: 0 for t in tx.FACT_TABLES}
        self.stats = {"rows": 0, "valid": 0, "corrupt": 0, "hint": 0, "failed": 0, "failures": []}
        self.error = None
        self._files = {}
        self._pool = None
        self._queue = queue.Queue(maxsize=max(2, 2 * self.workers))
        self._thread = threading.Thread(target=self._run, name="agent-evaluator-parse", daemon=True)
        self._thread.start()

    def put(self, batch) -> None:
        if self.error is not None:
            raise RuntimeError(f"transcript parsing stopped: {self.error}")
        self._queue.put(batch)

    def close(self):
        self._queue.put(None)
        self._thread.join()
        for fh in self._files.values():
            fh.close()
        if self._pool is not None:
            self._pool.shutdown(wait=True, cancel_futures=True)
            self._pool = None
        return self.error

    def _run(self):
        pending = deque()
        while True:
            batch = self._queue.get()
            if batch is None:
                break
            if self.error is not None:
                continue  # keep draining, so no reader blocks on a full queue
            try:
                self._submit(batch, pending)
                while pending and (pending[0][0] is None or pending[0][0].done()
                                   or len(pending) > 2 * self.workers):
                    self._finish(*pending.popleft())
            except BaseException as exc:  # noqa: BLE001 - handed to the caller by close()
                self.error = exc
        try:
            while pending and self.error is None:
                self._finish(*pending.popleft())
        except BaseException as exc:  # noqa: BLE001
            self.error = exc

    def _submit(self, batch, pending):
        if not self.inline:
            try:
                if self._pool is None:
                    self._pool = ProcessPoolExecutor(self.workers, mp_context=multiprocessing.get_context("spawn"))
                pending.append((self._pool.submit(tx.encode_chunk, batch), batch))
                return
            except Exception as exc:  # noqa: BLE001 - e.g. no process support here
                self._go_inline(exc)
        pending.append((None, batch))

    def _finish(self, future, batch):
        result = None
        if future is not None:
            try:
                result = future.result()
            except Exception as exc:  # noqa: BLE001 - a worker died; parse its batch here
                self._go_inline(exc)
        self._write(*(result or tx.encode_chunk(batch)))

    def _go_inline(self, exc):
        if self.inline:
            return
        log.warning("  parse workers failed (%s: %s); parsing in the job process instead", type(exc).__name__, exc)
        self.inline = True
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None

    def _write(self, blobs, counts, stats):
        for table, blob in blobs.items():
            if not blob:
                continue
            fh = self._files.get(table)
            if fh is None:
                fh = self._files[table] = open(self.folder / f"{table}.jsonl.gz", "wb")
            fh.write(blob)
        for table, n in counts.items():
            self.counts[table] += n
        for key in ("rows", "valid", "corrupt", "hint", "failed"):
            self.stats[key] += stats.get(key, 0)
        room = 5 - len(self.stats["failures"])
        if room > 0:
            self.stats["failures"] += list(stats.get("failures") or [])[:room]


# --------------------------------------------------------------------------------------------------- UPNs
def _no_access(status):
    return PermissionError(f"Graph returned HTTP {status}. Grant the jobs' managed identity Microsoft Graph "
                           "User.Read.All (application) so Agent Evaluator users show by UPN.")


def resolve_upns(api, ids) -> dict:
    """{object id (lower case): UPN (lower case)} for the IDs Graph knows (`/users` with `id in`, batched)."""
    found = {}
    queries = [ids[i:i + IDS_PER_QUERY] for i in range(0, len(ids), IDS_PER_QUERY)]
    for start in range(0, len(queries), QUERIES_PER_BATCH):
        pending = {str(n): qy for n, qy in enumerate(queries[start:start + QUERIES_PER_BATCH])}
        for attempt in range(6):
            if not pending:
                break
            body = {"requests": [
                {"id": key, "method": "GET",
                 "url": "/users?$filter=" + quote("id in (" + ",".join(f"'{i}'" for i in qy) + ")")
                        + "&$select=id,userPrincipalName"}
                for key, qy in pending.items()]}
            r = api.request("POST", BATCH_URL, json=body)
            if r.status_code in (401, 403):
                raise _no_access(r.status_code)
            if r.status_code == 429 or r.status_code >= 500:
                api.sleep(min(2 ** attempt, 60))
                continue
            if not 200 <= r.status_code < 300:
                raise RuntimeError(f"Graph $batch returned HTTP {r.status_code}")
            wait = 0.0
            for item in r.json().get("responses", []):
                status = int(item.get("status") or 0)
                if status == 200:
                    for u in (item.get("body") or {}).get("value", []):
                        if u.get("id") and u.get("userPrincipalName"):
                            found[u["id"].lower()] = u["userPrincipalName"].strip().lower()
                    pending.pop(item.get("id"), None)
                elif status in (401, 403):
                    raise _no_access(status)
                elif status == 429 or status >= 500:
                    try:
                        wait = max(wait, float((item.get("headers") or {}).get("Retry-After", 2 ** attempt)))
                    except (TypeError, ValueError):
                        wait = max(wait, float(2 ** attempt))
                else:
                    log.info("  UPN lookup query skipped: HTTP %s", status)
                    pending.pop(item.get("id"), None)
            if pending:
                api.sleep(min(wait or 2 ** attempt, 60))
        if pending:
            log.warning("  %s UPN lookup query(ies) still throttled; those users show by ID.", len(pending))
    return found


def _fill_upns(con, api, settings, has_old: bool) -> dict:
    """Fills the run's sessions' missing user_upn: first from earlier sessions of the same user, then Graph.
    Best effort, as in Fabric: when Graph says no, those users show by object ID."""
    out = {"upns_resolved": 0, "upns_reused": 0}
    if not settings.transcript_resolve_upns:
        return out
    ids = sorted({str(r[0]).strip().lower() for r in con.execute(
        "SELECT DISTINCT user_id_hash FROM new_agent_sessions "
        "WHERE (user_upn IS NULL OR trim(user_upn) = '') AND user_id_hash IS NOT NULL").fetchall()
        if GUID.match(str(r[0]).strip())})
    if not ids:
        return out
    known = {}
    if has_old:
        known = dict(con.execute(
            "SELECT lower(trim(user_id_hash)), arg_max(user_upn, coalesce(session_start_utc, '')) "
            "FROM old_agent_sessions WHERE user_id_hash IS NOT NULL AND user_upn IS NOT NULL "
            "AND trim(user_upn) <> '' GROUP BY 1").fetchall())
    upns = {i: known[i] for i in ids if i in known}
    out["upns_reused"] = len(upns)
    missing = [i for i in ids if i not in known]
    if missing:
        try:
            found = resolve_upns(api, missing)
            upns.update(found)
            out["upns_resolved"] = len(found)
            log.info("  resolved %s of %s user object IDs to UPNs", len(found), len(missing))
        except Exception as exc:  # noqa: BLE001 - best effort: those users show by ID
            log.warning("  UPN lookup skipped: %s", exc)
            out["upn_lookup_error"] = f"{type(exc).__name__}: {exc}"
    if upns:
        keys = sorted(upns)
        con.execute("CREATE OR REPLACE TEMP TABLE upn_map AS SELECT unnest(?::VARCHAR[]) AS id, "
                    "unnest(?::VARCHAR[]) AS upn", [keys, [upns[k] for k in keys]])
        con.execute("UPDATE new_agent_sessions SET user_upn = m.upn FROM upn_map m "
                    "WHERE m.id = lower(trim(new_agent_sessions.user_id_hash)) "
                    "AND (new_agent_sessions.user_upn IS NULL OR trim(new_agent_sessions.user_upn) = '')")
    return out


# --------------------------------------------------------------------------------------------------- merge
def _month_files(rels) -> dict:
    out = {}
    for rel in rels:
        m = MONTH_FILE.fullmatch(rel.rsplit("/", 1)[-1])
        if m:
            out[m.group(1)] = rel
    return out


def _projection(con, paths, cols) -> str:
    """The rows of `paths` with exactly `cols` (typed; NULL where a file doesn't have one)."""
    src = f"read_parquet([{', '.join(q(p) for p in paths)}], union_by_name=true)"
    have = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
    select = ", ".join(f"CAST({ident(c)} AS {_type(c)}) AS {ident(c)}" if c in have
                       else f"CAST(NULL AS {_type(c)}) AS {ident(c)}" for c in cols)
    return f"SELECT {select} FROM {src}"


def _fingerprint(con, path, cols):
    """(rows, row hash) of one month file, or None when its columns or types aren't the current ones."""
    src = f"read_parquet({q(path)})"
    have = [(r[0], r[1]) for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()]
    if have != [(c, _type(c)) for c in cols]:
        return None
    return tuple(con.execute(f"SELECT count(*), sum(hash(s)::HUGEINT) FROM {src} s").fetchone())


def _write_months(con, store, table: str, old: dict) -> tuple[list, list]:
    """Writes the months of merged_<table> whose rows changed and removes the ones left empty."""
    cols = tx.columns(table)
    merged = ident(f"merged_{table}")
    key = ident(tx.FACT_TABLES[table][0])
    fresh = {m: (n, h) for m, n, h in con.execute(
        f"SELECT {MONTH} AS m, count(*), sum(hash(s)::HUGEINT) FROM {merged} s GROUP BY m").fetchall()}
    written, removed = [], []
    for month in sorted(set(fresh) | set(old)):
        rel = old.get(month) or f"{prefix(table)}/month-{month}.parquet"
        if month not in fresh:
            removed.append(rel)
            continue
        if month in old and _fingerprint(con, store.path(rel), cols) == fresh[month]:
            continue
        path = store.path(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        con.execute(f"COPY (SELECT * FROM {merged} WHERE {MONTH} = '{month}' ORDER BY {key}, source_environment) "
                    f"TO {q(tmp)} (FORMAT PARQUET)")
        os.replace(tmp, path)
        store.push([rel])
        written.append(rel)
    if removed:
        store.remove(removed)
    return written, removed


def _catalogue(con) -> list:
    named = con.execute(
        "SELECT primary_agent_schema, agent_name FROM ("
        "  SELECT primary_agent_schema, agent_name, row_number() OVER (PARTITION BY primary_agent_schema"
        "         ORDER BY session_start_utc DESC NULLS LAST, agent_name) AS rk"
        "  FROM merged_agent_sessions WHERE primary_agent_schema IS NOT NULL AND agent_name IS NOT NULL"
        "  AND trim(agent_name) <> '') WHERE rk = 1").fetchall()
    schemas = [r[0] for r in con.execute(
        "SELECT primary_agent_schema FROM merged_agent_sessions WHERE primary_agent_schema IS NOT NULL "
        "UNION SELECT connected_agent_schema FROM merged_agent_subagents WHERE connected_agent_schema IS NOT NULL "
        "UNION SELECT parent_agent_schema FROM merged_agent_subagents WHERE parent_agent_schema IS NOT NULL"
    ).fetchall()]
    envs = dict(con.execute(
        "SELECT primary_agent_schema, array_to_string(list_sort(list(DISTINCT source_environment)), '|') "
        "FROM merged_agent_sessions WHERE primary_agent_schema IS NOT NULL AND source_environment IS NOT NULL "
        "AND source_environment <> '' GROUP BY 1").fetchall())
    return tx.catalogue_rows(schemas, named, envs)


def _new_rows(spool: Path, table: str, counts: dict) -> str:
    """SQL for the run's rows of `table`, read from its spool file (typed; no rows when the run has none)."""
    cols = tx.columns(table)
    if not counts.get(table):
        return "SELECT " + ", ".join(f"CAST(NULL AS {_type(c)}) AS {ident(c)}" for c in cols) + " WHERE false"
    spec = "{" + ", ".join(f"'{c}': '{_type(c)}'" for c in cols) + "}"
    return (f"SELECT {', '.join(ident(c) for c in cols)} FROM read_json({q(spool / f'{table}.jsonl.gz')}, "
            f"format='newline_delimited', compression='gzip', columns={spec})")


def _merge(store, spool: Path, counts: dict, work: Path, api, settings) -> dict:
    """Merges the spooled rows into the month files, one table at a time, so only one table's merged rows are
    held at once (sessions and subagents stay for the catalogue). Returns what it wrote, plus the catalogue."""
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone = 'UTC'")
        spill = work / "spill"
        spill.mkdir(exist_ok=True)
        con.execute(f"SET temp_directory = {q(spill)}")
        con.execute(f"SET memory_limit = {q(os.environ.get('VALUELENS_DUCKDB_MEMORY_LIMIT') or MERGE_MEMORY)}")
        con.execute(f"CREATE TEMP TABLE new_agent_sessions AS {_new_rows(spool, 'agent_sessions', counts)}")

        old = {t: _month_files(store.pull(prefix(t))) for t in FULL_HISTORY}
        for table, files in old.items():
            if files:
                con.execute(f"CREATE TEMP VIEW {ident('old_' + table)} AS "
                            f"{_projection(con, [store.path(r) for r in files.values()], tx.columns(table))}")
        out = _fill_upns(con, api, settings, bool(old["agent_sessions"]))

        con.execute("CREATE TEMP TABLE run_keys AS SELECT DISTINCT conversation_id AS id, source_environment AS env "
                    "FROM new_agent_sessions")
        months = {r[0] for r in con.execute(f"SELECT DISTINCT {MONTH} FROM new_agent_sessions").fetchall()}
        if old["agent_sessions"]:
            months |= {r[0] for r in con.execute(
                f"SELECT DISTINCT {MONTH} FROM old_agent_sessions o WHERE EXISTS (SELECT 1 FROM run_keys k "
                "WHERE k.id = o.conversation_id AND k.env IS NOT DISTINCT FROM o.source_environment)").fetchall()}
        for table in tx.FACT_TABLES:
            if table in FULL_HISTORY:
                continue
            files = _month_files(store.list(prefix(table))) if months else {}
            old[table] = {m: rel for m, rel in files.items() if m in months}
            for rel in old[table].values():
                store.pull(rel)
            if old[table]:
                con.execute(f"CREATE TEMP VIEW {ident('old_' + table)} AS "
                            f"{_projection(con, [store.path(r) for r in old[table].values()], tx.columns(table))}")

        written, removed = [], []
        for table in WRITE_ORDER:
            key = ident(tx.FACT_TABLES[table][0])
            rows = "SELECT * FROM new_agent_sessions" if table == "agent_sessions" else _new_rows(spool, table, counts)
            if old[table]:
                rows = (f"SELECT * FROM {ident('old_' + table)} o WHERE NOT EXISTS (SELECT 1 FROM run_keys k "
                        f"WHERE k.id = o.{key} AND k.env IS NOT DISTINCT FROM o.source_environment) UNION ALL {rows}")
            if table == "agent_sessions":
                # A user with more than one conversation, across every transcript kept (Fabric: within a run).
                rows = ("SELECT * REPLACE (CASE WHEN coalesce(user_id_hash, '') <> '' AND count(*) OVER "
                        "(PARTITION BY user_id_hash) > 1 THEN 'True' ELSE 'False' END AS is_returning_user) "
                        f"FROM ({rows})")
            con.execute(f"CREATE TEMP TABLE {ident('merged_' + table)} AS {rows}")
            w, r = _write_months(con, store, table, old[table])
            written += w
            removed += r
            if table not in FULL_HISTORY:
                con.execute(f"DROP TABLE {ident('merged_' + table)}")
        out.update({"months_written": len(written), "months_removed": len(removed),
                    "catalogue": _catalogue(con),
                    "sessions_total": con.execute("SELECT count(*) FROM merged_agent_sessions").fetchone()[0]})
        return out
    finally:
        con.close()


# ------------------------------------------------------------------------------------------------- the run
def _write_status(store, rows) -> None:
    write_rows(store.path(STATUS), tx.STATUS_COLUMNS, rows, tx.STATUS_TYPES)
    store.push([STATUS])


def collect_agent_evaluator(api, store, settings, *, now=None) -> dict:
    environments = list(settings.dataverse_environments)
    if not environments:
        raise ValueError("Agent Evaluator has no Dataverse environments to read: set "
                         "VALUELENS_DATAVERSE_ENVIRONMENTS (the installer's Repair or change picks them).")
    now = _utc(now)
    run_at = now.replace(tzinfo=None)
    urls = [u for u, _ in environments]
    names = {u: n for u, n in environments if n}
    state = store.read_json(STATE, {}) or {}
    last = {u: t for u, t in (state.get("last_success") or {}).items() if u in urls}
    env_days = {}
    for url in urls:
        days = tx.env_lookback(last.get(url), now, settings.transcript_lookback_days,
                               settings.transcript_first_read_days)
        if settings.audit_backfill_days > 0 and days > 0:
            days = max(days, settings.audit_backfill_days, settings.transcript_first_read_days)
        env_days[url] = days
        if url not in last and days:
            log.info("  %s: first complete read, so going back %s days", url, days)
    bad = _token_errors(api, urls)
    tasks = [(url, ws, we) for url in urls if url not in bad
             for ws, we in tx.windows(env_days[url], settings.transcript_windows, now)]
    log.info("Agent Evaluator: %s environment(s), %s read window(s), up to %s at a time",
             len(urls), len(tasks), settings.transcript_parallel)

    env_ids = {url: set() for url in urls if url not in bad}
    lock = threading.Lock()
    errs = []
    with tempfile.TemporaryDirectory(prefix="valuelens-ae-") as tmp:
        work = Path(tmp)
        spool = work / "rows"
        spool.mkdir()
        parser = _Parser(spool, _workers(settings.transcript_parse_workers))

        def read(task):
            url, ws, we = task

            def on_page(page):
                fresh = []
                with lock:
                    seen = env_ids[url]
                    for rec in page:
                        staged = tx.staged_record(rec, url)
                        key = staged.get("conversationtranscriptid") or f"#{len(seen)}"
                        if key in seen:
                            continue
                        seen.add(key)
                        fresh.append(tx.normalise(staged))
                for i in range(0, len(fresh), PARSE_CHUNK):
                    parser.put(fresh[i:i + PARSE_CHUNK])

            return fetch_window(api, url, ws, we, on_page, settings.transcript_page_size)

        try:
            if tasks:
                workers = max(1, min(int(settings.transcript_parallel), len(tasks)))
                with ThreadPoolExecutor(workers, thread_name_prefix="agent-evaluator") as pool:
                    futures = {pool.submit(read, t): t for t in tasks}
                    for fut in as_completed(futures):
                        url, ws, we = futures[fut]
                        try:
                            log.info("  %s [%s .. %s]: +%s", url, ws or "start", we or "now", f"{fut.result():,}")
                        except Exception as exc:  # noqa: BLE001 - recorded in evaluator_status
                            errs.append(((url, ws, we), exc))
                            log.warning("  window failed %s [%s .. %s]: %s", url, ws, we, exc)
        finally:
            error = parser.close()
        if error is not None:
            raise RuntimeError(f"Agent Evaluator couldn't parse the transcripts: {type(error).__name__}: "
                               f"{error}") from error

        status = tx.evaluator_status_rows(urls, env_ids, bad, errs, env_days, names, run_at)
        summary = {
            "environments": {r[2]: {"days": r[3], "transcripts": r[4], "status": r[5]} for r in status},
            "windows": len(tasks), "windows_failed": len(errs), "rows": dict(parser.counts),
            "parse": dict(parser.stats),
        }
        if not tasks or len(errs) == len(tasks):
            _write_status(store, status)
            reasons = "; ".join(f"{r[1]}: {r[6]}" for r in status)
            raise RuntimeError(f"Agent Evaluator read no environment: {reasons}"[:2000])
        stats = parser.stats
        log.info("  parsed %s transcript(s): %s with JSON content, %s without a transcript ID, %s couldn't be "
                 "parsed", f"{stats['rows']:,}", f"{stats['valid']:,}", stats["corrupt"], stats["failed"])
        for sample in stats["failures"]:
            log.warning("  couldn't parse %s", sample)
        merged = _merge(store, spool, parser.counts, work, api, settings)

    catalogue = merged.pop("catalogue")
    write_rows(store.path(CATALOGUE), tx.CATALOGUE_COLUMNS,
               [[row[c] for c in tx.CATALOGUE_COLUMNS] for row in catalogue])
    store.push([CATALOGUE])
    _write_status(store, status)
    failed = {t[0] for t, _ in errs}
    done = now.isoformat()
    last.update({url: done for url in urls if url not in bad and url not in failed})
    store.write_json(STATE, {"last_success": last})
    for r in status:
        log.info("  %-9s %s: %s", r[5], r[1], r[6])
    summary.update(merged)
    summary["agents"] = len(catalogue)
    if errs or bad:
        summary["warnings"] = [f"{r[1]}: {r[6]}" for r in status if r[5] != "ok" or "failed" in r[6]]
    return summary
