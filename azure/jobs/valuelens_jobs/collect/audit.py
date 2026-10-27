"""Purview audit log (Copilot interactions) -> raw/copilot_interactions_parsed/day-YYYYMMDD.parquet.

Port of the Fabric `Copilot_Audit_Log_Ingester` notebook:
* the same window grid (`CHUNK_HOURS`), bounded concurrency and per-query wait ceiling;
* a manifest of finished windows so a failed run resumes without re-querying them;
* windows within the trailing look-back are always re-queried (late-arriving records);
* a failing window is re-queried with backoff, then split in halves down to `MIN_CHUNK_HOURS`;
  failures and 429s lower concurrency for the rest of the run (same helpers as the notebook);
* a window whose query hit the audit service's record cap (isRecordCountLimitExceeded) is split at once;
* when Graph refuses new audit searches (its per-tenant daily limit, HTTP 429), the run sends no more,
  keeps each window's query id and merges what finished; the next run carries on and re-polls those queries;
* records are canonicalised and flattened by `valuelens_core.audit` (golden-checked against Spark);
* new rows replace existing rows with the same `Id` (the notebook's Delta MERGE), one file per day;
* each page is staged gzip-compressed, and a long backfill merges in passes of whole days, so it fits the
  run job's memory and disk;
* a reload (VALUELENS_AUDIT_BACKFILL_DAYS, set on one run) is remembered in the state until a run has merged
  it, so one that outlasts a run carries over to the next runs;
* each window logs how long it waited for a query slot, for its query and to drain its pages;
* a window still empty when it leaves the look-back is queried once more (EMPTY_RECHECK_DAYS), since the audit
  service can answer with no records and add them later, and a run where every window is empty logs what to check.
"""
from __future__ import annotations

import gzip
import json
import logging
import math
import os
import re
import statistics
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait as wait_futures
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import duckdb

from valuelens_core import audit

from ..api import GRAPH, TRANSIENT, HttpError, _is_network_error, raise_for_status
from ..tables import ident, q

log = logging.getLogger("valuelens_jobs.collect.audit")

QUERIES = "https://graph.microsoft.com/beta/security/auditLog/queries"
PARSED = "raw/copilot_interactions_parsed"
STAGING = "raw/_audit_staging"
STATE = "raw/_state/audit.json"
# The state key holding where an unmerged reload starts.
BACKFILL_FROM = "backfill_from"
CHUNK_HOURS = 8
# Graph allows 50 audit searches queued or running per tenant and 200 new ones in a rolling 24 hours, shared
# with other admins and tools; 5 at a time leaves room for them.
MAX_CONCURRENT_QUERIES = 5
MAX_WAIT_MIN_PER_QUERY = 240
POLL_INTERVAL_SEC = 30
WINDOW_RETRIES = 3
MIN_CHUNK_HOURS = 1
SPLIT_ON_TIMEOUT = True
RETRY_BASE_SEC = 60
RETRY_MAX_SEC = 900
MIN_CONCURRENT_QUERIES = 1
PAGE_RECORDS = 999
# Staged records one merge pass flattens. More (a long backfill, or a large tenant's first run) merge in passes
# of whole days, oldest first, so memory and spill follow the largest pass, not the whole history.
MERGE_PASS_RECORDS = 250_000
# A 429 asking to wait longer than this is the tenant's daily audit search limit, not a burst: stop asking.
QUOTA_RETRY_AFTER_SEC = 300
# A query an earlier run left running is re-polled, not re-sent, for this long after it was created.
RESUME_QUERY_HOURS = 12
# A window still empty when it leaves the look-back is queried once more if it ended in the last
# EMPTY_RECHECK_DAYS, oldest first and at most EMPTY_RECHECK_MAX a run (each one is an audit search).
EMPTY_RECHECK_DAYS = 30
EMPTY_RECHECK_MAX = 24


class AuditQueryFailed(RuntimeError):
    """The audit service ended a query as failed or cancelled; a new query for the window may succeed."""


class QueryQuotaReached(RuntimeError):
    """Graph refused audit searches for the tenant (HTTP 429): the window is left for the next run."""


class RecordLimitExceeded(RuntimeError):
    """The query hit the audit service's record cap (isRecordCountLimitExceeded): the window is split."""


def _resumable_query_id(entry, now, max_hours):
    """The query an earlier run left running for this window, if it is recent enough to re-poll."""
    entry = entry or {}
    qid = entry.get("query_id")
    if entry.get("status") not in ("querying", "waiting", "draining") or not max_hours or max_hours <= 0:
        return None
    if not isinstance(qid, str) or not qid.strip():
        return None
    created = audit._as_utc_datetime(entry.get("query_created_at"))
    if created is None or now - created > timedelta(hours=max_hours):
        return None
    return qid.strip()


def _refuse_on_quota(r, what):
    if r.status_code == 429:
        raise QueryQuotaReached(f"Graph refused {what} for the tenant (HTTP 429)")


def is_retryable(exc) -> bool:
    if isinstance(exc, (AuditQueryFailed, TimeoutError)):
        return True
    if isinstance(exc, HttpError):
        return exc.status_code in TRANSIENT
    return _is_network_error(exc)


def day_file(day) -> str:
    return f"{PARSED}/day-{day:%Y%m%d}.parquet" if day else f"{PARSED}/day-none.parquet"


def _iso(value) -> str:
    return audit._as_utc_datetime(value).isoformat()


def _range(ws, we) -> str:
    return f"{audit._as_utc_datetime(ws):%Y-%m-%d %H:%M}-{audit._as_utc_datetime(we):%H:%M} UTC"


def _window_key(rel: str) -> str:
    """The window key of a staged page, `raw/_audit_staging/win_<key>_<page>.jsonl[.gz]`."""
    return rel.split("/")[-1].split("_", 1)[-1].rsplit("_", 1)[0]


class AuditCollector:
    def __init__(self, api, store, settings, *, now=None, sleep=time.sleep, clock=time.monotonic,
                 poll_seconds=POLL_INTERVAL_SEC, max_wait_minutes=MAX_WAIT_MIN_PER_QUERY, chunk_hours=CHUNK_HOURS,
                 max_concurrent=MAX_CONCURRENT_QUERIES, window_retries=WINDOW_RETRIES,
                 min_chunk_hours=MIN_CHUNK_HOURS, split_on_timeout=SPLIT_ON_TIMEOUT,
                 retry_base_seconds=RETRY_BASE_SEC, retry_max_seconds=RETRY_MAX_SEC,
                 min_concurrent=MIN_CONCURRENT_QUERIES, merge_pass_records=MERGE_PASS_RECORDS,
                 empty_recheck_days=EMPTY_RECHECK_DAYS, empty_recheck_max=EMPTY_RECHECK_MAX):
        self.api, self.store, self.settings = api, store, settings
        self.empty_recheck_days, self.empty_recheck_max = empty_recheck_days, empty_recheck_max
        self.merge_pass_records = max(int(merge_pass_records), 0)
        self.end = now or datetime.now(timezone.utc)
        self.sleep, self.clock = sleep, clock
        self.poll_seconds, self.max_wait_minutes = poll_seconds, max_wait_minutes
        self.chunk_hours, self.max_concurrent = chunk_hours, max_concurrent
        self.window_retries, self.min_chunk_hours = max(int(window_retries), 0), min_chunk_hours
        self.split_on_timeout = split_on_timeout
        self.retry_base_seconds, self.retry_max_seconds = retry_base_seconds, retry_max_seconds
        self.limiter = audit.AdaptiveLimiter(max_concurrent, min_concurrent)
        self._quota = threading.Event()
        self.lookback = max(int(settings.audit_lookback_days), 0)
        self._lock = threading.RLock()
        self.state = store.read_json(STATE, {}) or {}
        self.manifest = dict(self.state.get("windows") or {})
        self._timings, self._failed_attempts = [], 0

    # -------------------------------------------------------------- window plan
    def _backfill_days(self) -> int:
        return int(getattr(self.settings, "audit_backfill_days", 0) or 0)

    def remember_backfill(self):
        """Record where a reload starts, before fetching, until a run has merged it.

        The installer sets VALUELENS_AUDIT_BACKFILL_DAYS on one run only. If that run stops before its merge (at
        the run job's 4 hours), the next run would plan from the high-water mark and prune the reload's windows.
        With the start in the state, later runs plan the reload again and query only the windows not yet fetched.
        A bigger reload while one is pending moves the start earlier; a smaller one leaves it.
        """
        backfill = self._backfill_days()
        if backfill <= 0:
            return
        start = audit._as_utc_datetime(self.end - timedelta(days=backfill))
        with self._lock:
            pending = audit._as_utc_datetime(self.state.get(BACKFILL_FROM))
            if pending is not None and pending <= start:
                return
            self.state[BACKFILL_FROM] = start.isoformat()
            self._save()

    def plan(self):
        hw = self.state.get("high_water_mark")
        if hw:
            start = audit.determine_incremental_start(self.end, hw, self.lookback)
        else:
            start = self.end - timedelta(days=max(int(self.settings.audit_history_days), self.lookback, 1))
        # A reload of more history: the high-water mark would otherwise keep the run to the days since the last
        # one. Windows already loaded are reused. An unmerged reload stays in the state (remember_backfill), and
        # the window grid is anchored, so each run plans the same windows for it.
        backfill = self._backfill_days()
        if backfill > 0:
            start = min(start, self.end - timedelta(days=backfill))
        pending = audit._as_utc_datetime(self.state.get(BACKFILL_FROM))
        if pending is not None:
            start = min(audit._as_utc_datetime(start), pending)
        return audit.build_windows(start, self.end, self.chunk_hours)

    def plan_rechecks(self, windows):
        """Empty windows due one more query (`audit.empty_recheck_windows`), oldest first, at most
        `empty_recheck_max` a run, plus every window still flagged `RECHECK_PENDING` from a run that failed.

        Returns the plan with those windows before it added, the keys to query again even though they are
        reusable, and every due or pending key, which `prune` keeps until its turn. A window that overlaps the
        plan without being one of its windows is left. The keys to query again are flagged until a run merges.
        """
        with self._lock:
            snapshot = dict(self.manifest)
        pending = audit.pending_recheck_windows(snapshot)
        due = [w for w in audit.empty_recheck_windows(snapshot, self.end, self.end - timedelta(days=self.lookback),
                                                      self.empty_recheck_days, self.lookback) if w not in pending]
        planned = {audit.stable_window_key(ws, we) for ws, we in self.leaves(windows)}
        start = min((audit._as_utc_datetime(ws) for ws, _ in windows), default=None)

        def fit(ws):
            return [w for w in ws if audit.stable_window_key(*w) in planned or start is None or w[1] <= start]

        kept, fits = fit(pending), fit(due)
        picked = fits[:max(int(self.empty_recheck_max), 0)]
        recheck = {audit.stable_window_key(*w) for w in picked}
        if recheck:
            with self._lock:
                for key in recheck:
                    self.manifest[key] = {**(self.manifest.get(key) or {}), audit.RECHECK_PENDING: True}
                self._save()
        extra = [w for w in sorted(kept + picked) if audit.stable_window_key(*w) not in planned]
        return (extra + list(windows), recheck,
                {audit.stable_window_key(*w) for w in kept + fits})

    def clear_rechecks(self):
        """Every window merged: drop the `RECHECK_PENDING` flags."""
        with self._lock:
            flagged = [k for k, e in self.manifest.items() if isinstance(e, dict) and e.get(audit.RECHECK_PENDING)]
            for k in flagged:
                self.manifest[k] = {f: v for f, v in self.manifest[k].items() if f != audit.RECHECK_PENDING}
            if flagged:
                self._save()

    def check_token(self):
        """Warn when the managed identity's Graph token can't read Copilot audit records."""
        tokens = getattr(self.api, "tokens", None)
        try:
            token = tokens.get(GRAPH) if tokens is not None else None
        except Exception as exc:
            log.info("audit: could not read the Graph token to check its roles (%s)", type(exc).__name__)
            return
        problems = audit.audit_token_problems(token) if isinstance(token, str) else []
        if problems:
            log.warning("audit: %s. Searches may come back empty or be refused; re-run the installer to grant the "
                        "jobs' managed identity %s.", "; ".join(problems), audit.AUDIT_ROLE)

    def _files(self, key):
        return sorted(rel for rel in self.store.list(STAGING) if rel.split("/")[-1].startswith(f"win_{key}_"))

    def _reusable(self, key, win_end, entry) -> bool:
        if not entry or entry.get("status") != "succeeded" or not entry.get("completed_at"):
            return False
        if audit._as_utc_datetime(win_end) > self.end - timedelta(days=self.lookback):
            return False
        recorded = entry.get("files") or []
        if not recorded:
            return int(entry.get("rows", 0) or 0) == 0
        present = set(self._files(key))
        return all(f"{STAGING}/{name}" in present for name in recorded)

    def _mark(self, key, status, **extra):
        with self._lock:
            entry = dict(self.manifest.get(key) or {})
            entry.update(extra, status=status)
            self.manifest[key] = entry
            self._save()

    def _save(self):
        with self._lock:
            self.state["windows"] = self.manifest
            self.store.write_json(STATE, self.state)

    # -------------------------------------------------------------- Graph
    def create_query(self, ws, we) -> str:
        body = {
            "displayName": f"Copilot Interactions {ws:%Y%m%d%H%M}-{we:%Y%m%d%H%M}",
            "filterStartDateTime": ws.isoformat(),
            "filterEndDateTime": we.isoformat(),
            "recordTypeFilters": ["copilotInteraction"],
            "operationFilters": [],
        }
        r = self.api.post(QUERIES, json=body, timeout=60, give_up_after=QUOTA_RETRY_AFTER_SEC)
        _refuse_on_quota(r, "a new audit search")
        if r.status_code == 403:
            raise PermissionError("Graph returned 403 creating an audit log query. The jobs' managed identity "
                                  "needs AuditLogsQuery.Read.All; re-run the installer to grant it.")
        raise_for_status(r, "create audit query")
        return r.json()["id"]

    def wait(self, qid: str) -> int:
        """Poll a query until it succeeds; returns the number of polls."""
        return self._poll(qid)[0]

    def _poll(self, qid: str):
        """Poll a query until it succeeds; returns (polls, the query's last status payload)."""
        deadline = self.clock() + self.max_wait_minutes * 60
        polls = 0
        while True:
            r = self.api.get(f"{QUERIES}/{qid}", timeout=60, give_up_after=QUOTA_RETRY_AFTER_SEC)
            polls += 1
            _refuse_on_quota(r, f"status reads for audit query {qid}")
            raise_for_status(r, f"audit query {qid}")
            payload = r.json()
            status = payload.get("status") if isinstance(payload, dict) else None
            if not isinstance(status, str) or not status.strip():
                raise RuntimeError(f"Query {qid} returned missing/invalid status: {status!r}")
            status = status.strip().lower()
            if status == "succeeded":
                return polls, payload
            if status in ("failed", "cancelled"):
                raise AuditQueryFailed(f"Query {qid} ended with status: {status}")
            if status not in ("notstarted", "running"):
                raise RuntimeError(f"Query {qid} returned unexpected status: {status}")
            if self.clock() > deadline:
                raise TimeoutError(f"Query {qid} did not succeed within {self.max_wait_minutes} min.")
            self.sleep(self.poll_seconds)

    @staticmethod
    def _records_url(url, qid):
        if not isinstance(url, str) or not url.strip():
            raise RuntimeError(f"Query {qid} returned missing/invalid @odata.nextLink: {url!r}")
        p = urlparse(url.strip())
        if not (p.scheme == "https" and p.netloc == "graph.microsoft.com"
                and p.path.startswith(f"/beta/security/auditLog/queries/{qid}/records")):
            raise RuntimeError(f"Query {qid} returned non-Graph records continuation URL: {url}")
        return url.strip()

    def drain(self, qid, key):
        self.store.remove(self._files(key))
        url, seen, rows, page, files = (self._records_url(f"{QUERIES}/{qid}/records?$top={PAGE_RECORDS}", qid),
                                        set(), 0, 0, [])
        while url:
            if url in seen:
                raise RuntimeError(f"Query {qid} returned repeated pagination link cycle: {url}")
            seen.add(url)
            r = self.api.get(url, timeout=120, give_up_after=QUOTA_RETRY_AFTER_SEC)
            _refuse_on_quota(r, f"record reads for audit query {qid}")
            raise_for_status(r, f"audit records {qid}")
            payload = r.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("value"), list):
                raise RuntimeError(f"Query {qid} returned a malformed records page for {url}")
            values = payload["value"]
            if any(not isinstance(v, dict) for v in values):
                raise RuntimeError(f"Query {qid} records page has a non-object item for {url}")
            nxt = payload.get("@odata.nextLink")
            nxt = self._records_url(nxt, qid) if nxt is not None else None
            if values:
                # Compressed (about 10x): a long backfill's pages would otherwise fill the run job's disk.
                rel = f"{STAGING}/win_{key}_{page:04d}.jsonl.gz"
                path = self.store.path(rel)
                path.parent.mkdir(parents=True, exist_ok=True)
                with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as fh:
                    for record in values:
                        fh.write(json.dumps(audit.canonicalize_audit_record(record)))
                        fh.write("\n")
                self.store.push([rel])
                files.append(rel.split("/")[-1])
                page += 1
                rows += len(values)
            url = nxt
        return rows, files

    def _window(self, ws, we, attempt=1):
        key = audit.stable_window_key(ws, we)
        with self._lock:
            prior = dict(self.manifest.get(key) or {})
        resume = (_resumable_query_id(prior, datetime.now(timezone.utc), RESUME_QUERY_HOURS)
                  if attempt == 1 else None)
        if self._quota.is_set() and not resume:
            raise QueryQuotaReached("The audit search limit was reached earlier in this run")
        self._mark(key, "querying", window_start=_iso(ws), window_end=_iso(we),
                   refreshed_at=datetime.now(timezone.utc).isoformat(), completed_at=None, timing=None,
                   attempts=attempt, error=None, **({"attempt_errors": []} if attempt == 1 else {}))
        qid, payload = None, None
        try:
            queued = self.clock()
            # Only creating and waiting hold one of the tenant's concurrent query slots; draining doesn't.
            if resume:
                qid = resume
                try:
                    with self.limiter:
                        created = self.clock()
                        self._mark(key, "waiting", query_id=qid)
                        polls, payload = self._poll(qid)
                        ready = self.clock()
                    log.info("audit: window %s picked up query %s from an earlier run", key, qid)
                except (PermissionError, QueryQuotaReached):
                    raise
                except Exception as exc:
                    log.warning("audit: window %s: query %s from an earlier run could not be used (%s: %s); "
                                "sending a new one", key, qid, type(exc).__name__, exc)
                    qid = None
            if qid is None:
                with self.limiter:
                    if self._quota.is_set():
                        raise QueryQuotaReached("The audit search limit was reached earlier in this run")
                    created = self.clock()
                    qid = self.create_query(ws, we)
                    self._mark(key, "waiting", query_id=qid,
                               query_created_at=datetime.now(timezone.utc).isoformat())
                    polls, payload = self._poll(qid)
                    ready = self.clock()
            capped = isinstance(payload, dict) and payload.get("isRecordCountLimitExceeded") is True
            if capped and audit.split_window(ws, we, self.min_chunk_hours):
                raise RecordLimitExceeded(f"Query {qid} reached the audit service's record limit")
            if capped:
                log.warning("audit: window %s: query %s reached the audit service's record limit at the smallest "
                            "window (%gh); some of its records are missing", key, qid, self.min_chunk_hours)
            self._mark(key, "draining", query_id=qid)
            rows, files = self.drain(qid, key)
            timing = {"slot_wait_s": round(created - queued, 1), "ready_s": round(ready - created, 1),
                      "polls": polls, "drain_s": round(self.clock() - ready, 1)}
            self._mark(key, "succeeded", query_id=qid, rows=rows, pages=len(files), files=files, timing=timing,
                       completed_at=datetime.now(timezone.utc).isoformat(),
                       **({"record_limit_exceeded": True} if capped else {}))
            return key, rows, dict(timing, pages=len(files))
        except QueryQuotaReached:
            # Keep the query id, and any pages a finished window staged before: the next run re-polls the query.
            stopped = datetime.now(timezone.utc).isoformat()
            self._mark(key, "waiting", query_id=qid, paused_at=stopped, throttled_at=stopped)
            raise
        except Exception as exc:
            self._mark(key, "failed", error=f"{type(exc).__name__}: {exc}", query_id=qid, completed_at=None)
            self.store.remove(self._files(key))
            raise

    def _run_window(self, ws, we):
        """Fetch one window: retry with a new query, then split it when the retries run out.

        Returns (key, rows, outcome, detail); outcome is 'done' (detail = the window's timing), 'split'
        (detail = the halves), 'throttled' (Graph's audit search limit; the window is left for the next run)
        or 'failed' (detail = the last error). Only PermissionError (missing Graph permission) propagates.
        """
        key = audit.stable_window_key(ws, we)
        errors, last = [], None
        for attempt in range(1, self.window_retries + 2):
            started = self.clock()
            try:
                _, rows, timing = self._window(ws, we, attempt)
                return key, rows, "done", timing
            except PermissionError:
                raise
            except QueryQuotaReached:
                self._quota.set()
                return key, 0, "throttled", None
            except Exception as exc:
                last = f"{type(exc).__name__}: {exc}"
                errors.append(f"attempt {attempt}: {last}")
                with self._lock:
                    self._failed_attempts += 1
                self._mark(key, "failed", attempts=attempt, attempt_errors=errors[-5:])
                if isinstance(exc, RecordLimitExceeded):
                    log.warning("audit: window %s: %s; splitting it", key, last)
                    break
                retryable = is_retryable(exc)
                split = retryable and isinstance(exc, TimeoutError) and self.split_on_timeout
                delay = (audit.retry_delay(attempt, self.retry_base_seconds, self.retry_max_seconds)
                         if retryable and not split and attempt <= self.window_retries else None)
                log.warning("audit: window %s attempt %s failed after %.1fs: %s%s", key, attempt,
                            self.clock() - started, last,
                            "" if delay is None else f"; new query in {delay:.0f}s (retry {attempt}/"
                                                     f"{self.window_retries})")
                if not retryable:
                    return key, 0, "failed", last
                if self.limiter.shrink(f"{key}: {last}", halve=getattr(exc, "status_code", None) == 429):
                    log.warning("audit: concurrency lowered to %s after: %s", self.limiter.limit, last)
                if split:
                    break
                if delay is not None:
                    self.sleep(delay)
        halves = audit.split_window(ws, we, self.min_chunk_hours)
        if not halves:
            return key, 0, "failed", last
        self._mark(key, "split", parts=[audit.stable_window_key(a, b) for a, b in halves],
                   split_at=datetime.now(timezone.utc).isoformat(), error=last, completed_at=None)
        self.store.remove(self._files(key))
        return key, 0, "split", halves

    def leaves(self, windows, include_parents=False):
        """The windows holding a plan's data: split windows are replaced by their parts."""
        with self._lock:
            snapshot = dict(self.manifest)
        return [leaf for ws, we in windows
                for leaf in audit.expand_split_windows(snapshot, ws, we, self.min_chunk_hours, include_parents)]

    def _fetch(self, pending):
        outcomes, fatal = {}, None
        with ThreadPoolExecutor(max_workers=max(1, int(self.max_concurrent))) as pool:
            running = {pool.submit(self._run_window, ws, we): (ws, we) for ws, we in pending}
            while running:
                finished, _ = wait_futures(list(running), return_when=FIRST_COMPLETED)
                for fut in finished:
                    running.pop(fut)
                    if fut.cancelled():
                        continue
                    try:
                        key, rows, how, detail = fut.result()
                    except Exception as exc:
                        fatal = fatal or exc
                        for other in running:
                            other.cancel()
                        continue
                    outcomes[key] = how
                    if how == "split":
                        log.warning("audit: window %s kept failing or reached the record limit; split into %s "
                                    "parts", key, len(detail))
                        if fatal is None:
                            for half in detail:
                                running[pool.submit(self._run_window, *half)] = half
                    elif how == "failed":
                        log.warning("audit: window %s failed: %s", key, detail)
                    elif how == "throttled":
                        log.warning("audit: window %s left for the next run (audit search limit reached)", key)
                    else:
                        with self._lock:
                            self._timings.append(detail)
                        log.info("audit: window %s +%s record(s) in %s page(s); slot wait %.1fs, ready %.1fs "
                                 "(%s poll(s)), drain %.1fs", key, rows, detail["pages"], detail["slot_wait_s"],
                                 detail["ready_s"], detail["polls"], detail["drain_s"])
        if fatal is not None:
            raise fatal
        return outcomes

    def _log_fetch(self, seconds):
        """One line to size a reload from: the fetch's wall time and the queries' ready and drain times."""
        with self._lock:
            timings, failed = list(self._timings), self._failed_attempts
        line = f"audit: fetch took {seconds:.1f}s for {len(timings)} window(s), {failed} failed attempt(s)"
        if timings:
            ready = sorted(t["ready_s"] for t in timings)
            p90 = ready[math.ceil(0.9 * len(ready)) - 1]
            per_page = [t["drain_s"] / t["pages"] for t in timings if t["pages"]]
            line += (f"; ready median {statistics.median(ready):.1f}s, p90 {p90:.1f}s, max {ready[-1]:.1f}s; "
                     f"drain median {statistics.median(per_page) if per_page else 0:.2f}s a page over "
                     f"{sum(t['pages'] for t in timings)} page(s)")
        log.info(line)

    # -------------------------------------------------------------- run
    def run(self) -> dict:
        self.check_token()
        self.remember_backfill()
        windows, recheck, due = self.plan_rechecks(self.plan())
        self.store.pull(STAGING)
        leaves = self.leaves(windows)
        pending = [(ws, we) for ws, we in leaves
                   if audit.stable_window_key(ws, we) in recheck
                   or not self._reusable(audit.stable_window_key(ws, we), we,
                                         self.manifest.get(audit.stable_window_key(ws, we)))]
        log.info("audit: %s window(s) of %sh from %s; %s to query (<= %s at a time)%s", len(windows),
                 self.chunk_hours, windows[0][0] if windows else "-", len(pending), self.limiter.limit,
                 f"; {len(recheck)} came back empty before and are queried once more" if recheck else "")
        previous = getattr(self.api, "on_throttle", None)
        self.api.on_throttle = lambda: self.limiter.shrink("HTTP 429 (throttled) from Graph", halve=True)
        started = self.clock()
        try:
            outcomes = self._fetch(pending)
        finally:
            self.api.on_throttle = previous
        self._log_fetch(self.clock() - started)
        leaves = self.leaves(windows)
        keys = {audit.stable_window_key(ws, we) for ws, we in leaves}
        with self._lock:
            snapshot = dict(self.manifest)
        errors = [f"{_range(ws, we)}: {(snapshot.get(k) or {}).get('error') or (snapshot.get(k) or {}).get('status')}"
                  for ws, we in leaves
                  for k in [audit.stable_window_key(ws, we)]
                  if (snapshot.get(k) or {}).get("status") != "succeeded"]
        shrinks = ", ".join(f"{a}->{b}" for a, b, _ in self.limiter.history) or "unchanged"
        log.info("audit: %s planned window(s) -> %s after splits; fetched %s, split %s, failed %s; concurrency %s",
                 len(windows), len(leaves), sum(1 for v in outcomes.values() if v == "done"),
                 sum(1 for v in outcomes.values() if v == "split"), len(errors), shrinks)
        # Publish the windows that finished even when others failed, so one throttled window doesn't
        # leave the table empty. The high-water mark holds still until every window succeeds, so the
        # next run's plan still covers the failed ones.
        result = self.merge(keys, advance_high_water=not errors)
        if self._quota.is_set():
            raise RuntimeError(
                f"Microsoft Graph refused new audit searches for this tenant (HTTP 429) with {len(errors)} audit "
                f"window(s) still to fetch. The {result['rows']} row(s) from finished windows were merged. Graph "
                f"allows at least 200 audit searches in a rolling 24 hours, shared with other admins and tools; "
                f"the next run carries on from here and re-polls the searches already sent.")
        if errors:
            listed = "; ".join(errors[:10]) + (f"; ... and {len(errors) - 10} more" if len(errors) > 10 else "")
            raise RuntimeError(f"{len(errors)} audit window(s) failed; the {result['rows']} row(s) from finished "
                               f"windows were merged and the next run resumes the rest. Each failed window was "
                               f"retried {self.window_retries}x and split down to {self.min_chunk_hours:g}h. "
                               f"Failed: {listed}")
        if keys and result["rows"] == 0:
            log.warning("audit: every audit window succeeded, but none had Copilot interaction records (%s to %s). "
                        "If people used Copilot then, check that the jobs' managed identity has %s (re-run the "
                        "installer to grant it), that auditing is on in Microsoft Purview (Audit), and that a "
                        "Purview audit search for the same hours, record type CopilotInteraction, finds records. "
                        "Empty windows are queried once more after they leave the look-back.",
                        min(ws for ws, _ in leaves), max(we for _, we in leaves), audit.AUDIT_ROLE)
        # Every window merged: a reload is done. Kept on a failed window, a failed merge or a run cut off, so
        # the next run plans it again and `prune` keeps its windows. The same goes for re-queried empty windows.
        self.clear_rechecks()
        with self._lock:
            reload_from = self.state.pop(BACKFILL_FROM, None)
            if reload_from is not None:
                self._save()
        if reload_from is not None:
            log.info("audit: the reload from %s is merged", reload_from)
        self.prune({audit.stable_window_key(ws, we) for ws, we in self.leaves(windows, include_parents=True)} | due)
        return result

    def merge(self, keys, advance_high_water=True) -> dict:
        files = sorted(rel for rel in self.store.list(STAGING) if _window_key(rel) in keys)
        if not files:
            log.info("audit: no records in the window set")
            return {"rows": 0, "days": 0}
        passes = self._passes(files)
        total, records, prompted, days, newest = 0, 0, 0, set(), None
        # DuckDB spills to `.tmp` in the working directory by default, which the job's user can't create.
        with tempfile.TemporaryDirectory(prefix="valuelens-duckdb-") as spill:
            for number, part in enumerate(passes, 1):
                rows, staged, with_prompt, written, latest = self._merge_pass(part, spill)
                total, records, prompted = total + rows, records + staged, prompted + with_prompt
                days.update(written)
                if latest is not None and (newest is None or latest > newest):
                    newest = latest
                if len(passes) > 1:
                    log.info("audit: merge pass %s of %s: %s row(s) across %s day file(s)", number, len(passes),
                             rows, len(written))
        if records > prompted:
            log.info("audit: %s of %s staged record(s) have no user prompt (response-only events outside the "
                     "Copilot Studio runtime/Cowork task-row exceptions) and are not counted, as in every "
                     "ValueLens variant", records - prompted, records)
        if newest is not None and advance_high_water:
            old = audit._as_utc_datetime(self.state.get("high_water_mark"))
            newest = audit._as_utc_datetime(newest)
            self.state["high_water_mark"] = (max(old, newest) if old else newest).isoformat()
        self._save()
        log.info("audit: merged %s row(s) across %s day file(s)%s", total, len(days),
                 f" in {len(passes)} passes" if len(passes) > 1 else "")
        return {"rows": total, "days": len(days)}

    def _passes(self, files):
        """The staged pages in merge passes: whole days, oldest first, up to `merge_pass_records` records each.

        A day over the budget is a pass on its own. Rows replace rows by `Id`, so the passes write the same day
        files as one pass would.
        """
        days = {}
        for rel in files:
            key = _window_key(rel)
            start = re.fullmatch(r"v\d+_(\d{8})\d{4}_\d{12}", key)
            days.setdefault(start.group(1) if start else key, {}).setdefault(key, []).append(rel)
        passes, size = [], 0
        for day in sorted(days):
            # The manifest has each window's record count; its page count bounds it for an entry without one.
            records = sum(int((self.manifest.get(key) or {}).get("rows") or 0) or len(pages) * PAGE_RECORDS
                          for key, pages in days[day].items())
            if not passes or (self.merge_pass_records and size + records > self.merge_pass_records):
                passes.append([])
                size = 0
            passes[-1] += [rel for pages in days[day].values() for rel in pages]
            size += records
        return passes

    def _merge_pass(self, files, spill):
        """Flatten one pass's staged pages and replace their rows in the day files.

        Returns (rows merged, staged records, records with a prompt, the days written, the newest CreationDate).
        """
        con = duckdb.connect()
        try:
            con.execute("SET TimeZone = 'UTC'")
            con.execute(f"SET temp_directory = {q(spill)}")
            if os.environ.get("VALUELENS_DUCKDB_MEMORY_LIMIT"):
                con.execute(f"SET memory_limit = {q(os.environ['VALUELENS_DUCKDB_MEMORY_LIMIT'])}")
            cols = "{" + ", ".join(f"'{c}': 'VARCHAR'" for c in audit.STAGE_COLUMNS) + "}"
            paths = "[" + ", ".join(q(self.store.path(f)) for f in files) + "]"
            # Pages staged before compression (`.jsonl`) still read: DuckDB picks the codec by extension.
            staged = f"read_json({paths}, format='newline_delimited', columns={cols})"
            rel = audit.flatten(con, staged)
            con.execute(f"CREATE TEMP TABLE new_rows AS {rel.sql_query()}")
            records = con.execute(f"SELECT count(*) FROM {staged}").fetchone()[0]
            prompted = con.execute("SELECT count(DISTINCT Source_RecordKey) FROM new_rows").fetchone()[0]
            blank = con.execute("SELECT count(*) FROM new_rows WHERE Id IS NULL OR trim(Id) = ''").fetchone()[0]
            if blank:
                raise RuntimeError(f"{blank} parsed audit row(s) have a blank Id; refusing to merge duplicates.")
            select = ", ".join(ident(c) for c in audit.PARSED_COLUMNS)
            days = [d for (d,) in con.execute("SELECT DISTINCT InteractionDate FROM new_rows").fetchall()]
            total = 0
            for day in days:
                rel_path = day_file(day)
                self.store.pull(rel_path)
                target = self.store.path(rel_path)
                target.parent.mkdir(parents=True, exist_ok=True)
                match = "InteractionDate IS NULL" if day is None else f"InteractionDate = DATE '{day.isoformat()}'"
                source = f"SELECT {select} FROM new_rows WHERE {match}"
                if target.is_file():
                    # SELECT * so day files written before a column was added still merge; BY NAME fills the gap with NULL.
                    source = (f"SELECT {select} FROM ({source} UNION ALL BY NAME SELECT * FROM "
                              f"read_parquet({q(target)}) WHERE Id NOT IN (SELECT Id FROM new_rows))")
                tmp = target.with_suffix(".parquet.tmp")
                con.execute(f"COPY ({source} ORDER BY CreationDate, Id) TO {q(tmp)} (FORMAT PARQUET)")
                tmp.replace(target)
                self.store.push([rel_path])
                total += con.execute(f"SELECT count(*) FROM new_rows WHERE {match}").fetchone()[0]
            newest = con.execute("SELECT max(CreationDate) FROM new_rows").fetchone()[0]
            return total, records, prompted, days, newest
        finally:
            con.close()

    def prune(self, keys):
        stale = [k for k in self.manifest if k not in keys]
        if not stale:
            return
        self.store.remove([rel for rel in self.store.list(STAGING) if _window_key(rel) in stale])
        for k in stale:
            self.manifest.pop(k, None)
        self._save()


def collect_audit(api, store, settings, **kwargs) -> dict:
    try:
        return AuditCollector(api, store, settings, **kwargs).run()
    finally:
        # The staged pages stay in storage for the next run. `process`, later in this run, needs the disk.
        store.evict(STAGING)
