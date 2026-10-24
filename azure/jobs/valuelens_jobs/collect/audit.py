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
  service can answer with no records and add them later, and a run where every window is empty logs what to check;
* windows are fetched newest first, within the notebook's time budget, counted from the job's start: at the
  budget no window starts and a window part-way through pauses with its query ID. The windows that finished are
  merged, so the reports fill in after every run, and the next run carries on, polling a paused query again
  while it's under 26 hours old;
* each window merges once: the manifest marks it merged, and a window fetched again merges again;
* merged isn't published: the run job copies where the load had got to into `processed` when a process step
  starts, and into `published` once a publish has carried that step's output, so the installer's `status` counts as
  in the reports only what a run has published (see __main__).
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

from ..api import GRAPH, TRANSIENT, DeadlineReached, HttpError, _is_network_error, raise_for_status
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
# A window still empty when it leaves the look-back is queried once more if it ended in the last
# EMPTY_RECHECK_DAYS, oldest first and at most EMPTY_RECHECK_MAX a run (each one is an audit search).
EMPTY_RECHECK_DAYS = 30
EMPTY_RECHECK_MAX = 24
# A later run polls a paused window's query again while the query is younger than this, and otherwise starts a new
# one. Graph doesn't document how long it keeps an audit query, so a query it no longer has starts a new one too.
PAUSED_QUERY_MAX_AGE_HOURS = 26
# Window statuses whose query a later run can pick up: paused at the time budget, left waiting at Graph's audit
# search limit, or stopped mid-wait or mid-drain.
RESUMABLE = ("paused", "waiting", "draining")
# The load's progress while windows are left, for the installer's `status`. Removed once every window has merged.
PROGRESS = ("loaded_back_to", "windows_left", "paused_at")
# Where the load had got to. The run job copies these fields to `processed` when a process step starts, and to
# `published` once a publish has carried that step's output, so `status` can tell merged from published.
SEEN = ("high_water_mark", "pending_high_water_mark", "loaded_back_to", BACKFILL_FROM)


class AuditQueryFailed(RuntimeError):
    """The audit service ended a query as failed or cancelled; a new query for the window may succeed."""


class QueryQuotaReached(RuntimeError):
    """Graph refused audit searches for the tenant (HTTP 429): the window is left for the next run."""


class RecordLimitExceeded(RuntimeError):
    """The query hit the audit service's record cap (isRecordCountLimitExceeded): the window is split."""


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
                 empty_recheck_days=EMPTY_RECHECK_DAYS, empty_recheck_max=EMPTY_RECHECK_MAX, deadline=None,
                 hard_deadline=None):
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
        # `clock` readings, or None. At `deadline` (the fetch's time budget) no window starts and the windows
        # part-way through pause; `hard_deadline` is when the run job stops the replica.
        self.deadline, self.hard_deadline = deadline, hard_deadline
        self._clock0 = clock()
        self._finished = set()

    def _now(self) -> datetime:
        return self.end + timedelta(seconds=self.clock() - self._clock0)

    def _spent(self, wait=0.0) -> bool:
        """True when the time budget ends within `wait` seconds."""
        return self.deadline is not None and self.clock() + wait >= self.deadline

    def _check_budget(self, wait=0.0, what="the next step"):
        if self._spent(wait):
            raise DeadlineReached(f"the audit fetch's time budget ends before {what}")

    # -------------------------------------------------------------- window plan
    def _backfill_days(self) -> int:
        return int(getattr(self.settings, "audit_backfill_days", 0) or 0)

    def remember_backfill(self):
        """Record where a reload starts, before fetching, until a run has merged all of it.

        The installer sets VALUELENS_AUDIT_BACKFILL_DAYS on one run only. If that run pauses at its time budget, or
        is stopped before its merge, the next run would plan from the high-water mark and prune the reload's windows.
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

    def seed_published(self):
        """Count what an older job image merged as published, once, before this image fetches anything.

        An older image kept no record of what its runs published, and `status` read what they had merged as in the
        reports. Without a record, this image's first merge would make `status` read all of it as not yet
        published. Before a reload is remembered, so a reload asked for now doesn't count as published. A state
        this image has written (the record, or a window entry with `merged_at`) is left as it is.
        """
        with self._lock:
            if "published" in self.state or any(isinstance(e, dict) and "merged_at" in e
                                                for e in self.manifest.values()):
                return
            self.state["published"] = {k: self.state[k] for k in SEEN if self.state.get(k) is not None}
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

    def _reusable(self, key, win_end, entry, staged=None) -> bool:
        if not entry or entry.get("status") != "succeeded" or not entry.get("completed_at"):
            return False
        if audit._as_utc_datetime(win_end) > self.end - timedelta(days=self.lookback):
            return False
        recorded = entry.get("files") or []
        if not recorded:
            return int(entry.get("rows", 0) or 0) == 0
        present = set(self._files(key)) if staged is None else staged
        return all(f"{STAGING}/{name}" in present for name in recorded)

    def _paused_query(self, entry):
        """The query of a window an earlier run paused (or was stopped in), while it's young enough to poll again."""
        if not entry or entry.get("status") not in RESUMABLE or not entry.get("query_id"):
            return None
        created = audit._as_utc_datetime(entry.get("query_created_at"))
        if created is None or self._now() - created >= timedelta(hours=PAUSED_QUERY_MAX_AGE_HOURS):
            return None
        return {"query_id": entry["query_id"], "query_created_at": created.isoformat()}

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

    def wait(self, qid: str, waited: float = 0.0) -> int:
        """Poll a query until it succeeds; returns the number of polls."""
        return self._poll(qid, waited)[0]

    def _poll(self, qid: str, waited: float = 0.0):
        """Poll a query until it succeeds; returns (polls, the query's last status payload).

        `waited` is how long the query has run already (a query an earlier run paused), so the ceiling counts from
        its creation. At the time budget it raises DeadlineReached, and the window pauses with its query ID.
        """
        deadline = self.clock() + self.max_wait_minutes * 60 - waited
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
            self._check_budget(self.poll_seconds, f"query {qid}'s next poll")
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
            # At the budget the window pauses: its pages so far are removed, and the next run drains it again.
            self._check_budget(what=f"query {qid}'s next records page")
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
            prior = dict(self.manifest[key]) if key in self.manifest else None
        resume = self._paused_query(prior) if attempt == 1 else None
        if self._quota.is_set() and resume is None:
            raise QueryQuotaReached("The audit search limit was reached earlier in this run")
        # At the time budget a window that hasn't started stays as it was, for the next run; a retry pauses.
        if self._spent():
            if attempt > 1:
                self._pause(key, query_id=None, query_created_at=None)
            raise DeadlineReached(f"the audit fetch's time budget ends before window {key} starts")
        self._mark(key, "querying", window_start=_iso(ws), window_end=_iso(we),
                   refreshed_at=datetime.now(timezone.utc).isoformat(), completed_at=None, timing=None,
                   attempts=attempt, error=None, paused_at=None,
                   **({"attempt_errors": []} if attempt == 1 else {}))
        live = {}
        try:
            if resume is not None:
                try:
                    return self._query(key, ws, we, live, resume)
                except DeadlineReached:
                    raise
                except (AuditQueryFailed, HttpError) as exc:
                    # Graph no longer has the query, or it ended without results: start a new one.
                    if isinstance(exc, HttpError) and exc.status_code in TRANSIENT:
                        raise
                    log.warning("audit: window %s can't pick up its paused query %s (%s: %s); starting a new one",
                                key, resume["query_id"], type(exc).__name__, exc)
                    self.store.remove(self._files(key))
                    live.clear()
                    prior = dict(prior or {}, query_id=None, query_created_at=None)
            return self._query(key, ws, we, live)
        except QueryQuotaReached:
            self._throttle(key, **live)
            raise
        except DeadlineReached:
            if live.get("query_id"):
                self._pause(key, **live)
            elif attempt == 1:
                # No query was created: the window goes back to how it was, a paused query included.
                with self._lock:
                    if prior is None:
                        self.manifest.pop(key, None)
                    else:
                        self.manifest[key] = prior
                    self._save()
            else:
                self._pause(key, query_id=None, query_created_at=None)
            raise
        except Exception as exc:
            self._mark(key, "failed", error=f"{type(exc).__name__}: {exc}", query_id=live.get("query_id"),
                       completed_at=None)
            self.store.remove(self._files(key))
            raise

    def _query(self, key, ws, we, live, resume=None):
        """Create a window's query (or poll a paused one again), wait for it and drain its pages.

        `live` gets the query's ID and creation time as soon as there is one, so the caller can pause with them.
        """
        queued = self.clock()
        # Only creating and waiting hold one of the tenant's concurrent query slots; draining doesn't.
        with self.limiter:
            self._check_budget(what=f"window {key}'s query")
            if resume is None and self._quota.is_set():
                raise QueryQuotaReached("The audit search limit was reached earlier in this run")
            created = self.clock()
            if resume is None:
                live["query_created_at"] = self._now().isoformat()
                live["query_id"] = self.create_query(ws, we)
                waited = 0.0
            else:
                live.update(resume)
                waited = max((self._now() - audit._as_utc_datetime(resume["query_created_at"])).total_seconds(), 0.0)
                log.info("audit: window %s polls its paused query %s again", key, resume["query_id"])
            qid = live["query_id"]
            self._mark(key, "waiting", **live)
            polls, payload = self._poll(qid, waited)
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
        if resume is not None:
            timing["resumed"] = True
        # `merged_at` is when the window's rows last reached the day files. New pages clear it until they merge.
        self._mark(key, "succeeded", query_id=qid, rows=rows, pages=len(files), files=files, timing=timing,
                   completed_at=datetime.now(timezone.utc).isoformat(), paused_at=None, merged_at=None,
                   **({"record_limit_exceeded": True} if capped else {}))
        with self._lock:
            self._finished.add(key)
        return key, rows, dict(timing, pages=len(files))

    def _pause(self, key, **query):
        """Leave a window for a later run at the time budget: its pages so far are removed, its query kept.

        A window merged in an earlier run (a look-back re-read) keeps `merged_at`: its rows are still in the day files.
        """
        self.store.remove(self._files(key))
        self._mark(key, "paused", files=[], pages=0, rows=0, timing=None, completed_at=None,
                   paused_at=self._now().isoformat(), **query)

    def _throttle(self, key, query_id=None, query_created_at=None):
        """Leave a window for a later run at Graph's audit search limit: its pages are removed, its query kept.

        The next run polls the query again, or starts one when it had none. `throttled_at` and `paused_at` get the
        same time, which is how the installer's `status` tells this stop from one at the time budget. A window merged
        in an earlier run keeps `merged_at`.
        """
        self.store.remove(self._files(key))
        stopped = self._now().isoformat()
        self._mark(key, "waiting", files=[], pages=0, rows=0, timing=None, completed_at=None, paused_at=stopped,
                   throttled_at=stopped, query_id=query_id, query_created_at=query_created_at if query_id else None)

    def _run_window(self, ws, we):
        """Fetch one window: retry with a new query, then split it when the retries run out.

        Returns (key, rows, outcome, detail); outcome is 'done' (detail = the window's timing), 'split'
        (detail = the halves), 'throttled' (Graph's audit search limit; the window is left for the next run),
        'failed' (detail = the last error) or 'paused' (the time budget ended; the window isn't split, and a later
        run fetches it). Only PermissionError (missing Graph permission) propagates.
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
            except DeadlineReached as exc:
                log.info("audit: window %s paused: %s", key, exc)
                return key, 0, "paused", None
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
                    if self._spent(delay):
                        self._pause(key, query_id=None, query_created_at=None)
                        log.info("audit: window %s paused: the time budget ends before its retry", key)
                        return key, 0, "paused", None
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
        """Fetch windows newest first, up to `max_concurrent` at a time, until the time budget.

        Returns {key: outcome} for the windows that started. At the budget, or once a window has paused at it, no
        window starts; the ones not started are left out and stay as they were.
        """
        def order(window):
            return audit._as_utc_datetime(window[0]), audit._as_utc_datetime(window[1])

        queue = sorted(pending, key=order)
        slots = max(1, int(self.max_concurrent))
        outcomes, fatal, running, paused = {}, None, {}, False
        with ThreadPoolExecutor(max_workers=slots) as pool:
            while True:
                # A window pauses when the budget ends within its next poll, page or retry wait, so one started
                # after it would only create a query and pause too.
                while queue and fatal is None and not paused and len(running) < slots and not self._spent():
                    window = queue.pop()
                    running[pool.submit(self._run_window, *window)] = window
                if not running:
                    break
                finished, _ = wait_futures(list(running), return_when=FIRST_COMPLETED)
                for fut in finished:
                    running.pop(fut)
                    try:
                        key, rows, how, detail = fut.result()
                    except Exception as exc:
                        fatal = fatal or exc
                        continue
                    outcomes[key] = how
                    if how == "paused":
                        paused = True
                    elif how == "split":
                        log.warning("audit: window %s kept failing or reached the record limit; split into %s "
                                    "parts", key, len(detail))
                        queue = sorted(queue + list(detail), key=order)
                    elif how == "failed":
                        log.warning("audit: window %s failed: %s", key, detail)
                    elif how == "throttled":
                        log.warning("audit: window %s left for the next run (audit search limit reached)", key)
                    elif how == "done":
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
        self.seed_published()
        self.remember_backfill()
        windows, recheck, due = self.plan_rechecks(self.plan())
        with self._lock:
            loading = not self.state.get("high_water_mark") or self.state.get(BACKFILL_FROM) is not None
        # Listed once for every window's reuse check. A window's staged pages are downloaded only when it
        # merges (see `merge`), so a merged window's pages aren't downloaded again each run.
        staged = set(self.store.list(STAGING))
        leaves = self.leaves(windows)
        pending, reused = [], set()
        for ws, we in leaves:
            key = audit.stable_window_key(ws, we)
            if key not in recheck and self._reusable(key, we, self.manifest.get(key), staged):
                reused.add(key)
            else:
                pending.append((ws, we))
        budget = ("" if self.deadline is None
                  else f"; newest first, within a time budget of {max(self.deadline - self.clock(), 0) / 60:.0f} min")
        log.info("audit: %s window(s) of %sh from %s; %s to query (<= %s at a time)%s%s", len(windows),
                 self.chunk_hours, windows[0][0] if windows else "-", len(pending), self.limiter.limit,
                 f"; {len(recheck)} came back empty before and are queried once more" if recheck else "", budget)
        before = {name: getattr(self.api, name, None) for name in ("on_throttle", "deadline", "clock")}
        self.api.on_throttle = lambda: self.limiter.shrink("HTTP 429 (throttled) from Graph", halve=True)
        if self.deadline is not None:
            # A throttled or failing request stops waiting at the budget too, and its window pauses.
            self.api.deadline, self.api.clock = self.deadline, self.clock
        started = self.clock()
        try:
            outcomes = self._fetch(pending)
        finally:
            self.api.on_throttle = before["on_throttle"]
            if self.deadline is not None:
                self.api.deadline, self.api.clock = before["deadline"], before["clock"]
        stopped = self._now()
        self._log_fetch(self.clock() - started)
        leaves = self.leaves(windows)
        with self._lock:
            snapshot = dict(self.manifest)
            finished = set(self._finished)
        # Done: fetched in this run, or kept from an earlier one. Failed: ran out of retries in this run. Left: the
        # rest, for the next run (paused at the time budget, left at the search limit, or not started).
        done, failed, left = [], [], []
        # Windows of the history this run fetched: not the trailing look-back's, which every run fetches again.
        loaded, look_back = 0, self.end - timedelta(days=self.lookback)
        for ws, we in leaves:
            key = audit.stable_window_key(ws, we)
            entry = snapshot.get(key) or {}
            if entry.get("status") == "succeeded" and (key in finished or key in reused):
                done.append(key)
                if key in finished and audit._as_utc_datetime(we) <= look_back:
                    loaded += 1
            elif outcomes.get(key) == "failed":
                failed.append(f"{_range(ws, we)}: {entry.get('error') or entry.get('status')}")
            else:
                left.append(key)
        complete = not failed and not left
        shrinks = ", ".join(f"{a}->{b}" for a, b, _ in self.limiter.history) or "unchanged"
        log.info("audit: %s planned window(s) -> %s after splits; fetched %s, split %s, failed %s; concurrency %s%s",
                 len(windows), len(leaves), sum(1 for v in outcomes.values() if v == "done"),
                 sum(1 for v in outcomes.values() if v == "split"), len(failed), shrinks,
                 f"; {len(left)} left for the next run" if left else "")
        # Each window merges once: a window fetched again (the trailing look-back) merges again.
        to_merge = {key for key in done if not (snapshot.get(key) or {}).get("merged_at")}
        if self.hard_deadline is not None:
            # Removed once the run has published, and the run job records the merge-to-publish time from
            # `clock`. Still here at the next run's start, this run was stopped in between, and the next run's
            # reserve grows to cover at least the `cutoff_s` this one had left (see __main__).
            with self._lock:
                self.state["merge_open"] = {"started_at": self._now().isoformat(), "clock": self.clock(),
                                            "cutoff_s": round(max(self.hard_deadline - self.clock(), 0.0), 1)}
                self._save()
        # Publish the windows that finished even when others failed or are left for the next run, so one
        # throttled window, or a first load longer than a run, doesn't leave the table empty. The high-water
        # mark holds still until every window has merged, so the next run's plan still covers the rest.
        result = self.merge(to_merge, advance_high_water=complete)
        with self._lock:
            if complete:
                for name in PROGRESS:
                    self.state.pop(name, None)
            else:
                self.state["loaded_back_to"] = self._loaded_back_to(leaves)
                self.state["windows_left"] = len(left) + len(failed)
                # Paused at the time budget. A stop at the audit search limit is an error, not a pause, and
                # `status` names the limit from the windows' own marks.
                if left and not self._quota.is_set():
                    self.state["paused_at"] = stopped.isoformat()
                else:
                    self.state.pop("paused_at", None)
                if loading and result["rows"]:
                    # Months merged newest first can differ from one pass over the history (an agent link
                    # found in an older month), so the run that loads the rest rebuilds the tables once.
                    self.state["rebuild_when_loaded"] = True
            self._save()
        if self._quota.is_set():
            raise RuntimeError(
                f"Microsoft Graph refused new audit searches for this tenant (HTTP 429) with "
                f"{len(left) + len(failed)} audit window(s) still to fetch. The {result['rows']} row(s) from finished "
                f"windows were merged. Graph allows at least 200 audit searches in a rolling 24 hours, shared with "
                f"other admins and tools; the next run carries on from here and re-polls the searches already sent.")
        if failed:
            listed = "; ".join(failed[:10]) + (f"; ... and {len(failed) - 10} more" if len(failed) > 10 else "")
            raise RuntimeError(f"{len(failed)} audit window(s) failed; the {result['rows']} row(s) from finished "
                               f"windows were merged and the next run resumes the rest. Each failed window was "
                               f"retried {self.window_retries}x and split down to {self.min_chunk_hours:g}h. "
                               f"Failed: {listed}")
        if left:
            # The reload stays in the state and nothing is pruned, so the next run plans the same windows.
            back_to = self.state.get("loaded_back_to")
            log.info("audit: History loaded back to %s. The next run carries on (%s windows left).",
                     back_to[:10] if back_to else "nothing yet", len(left))
            return dict(result, paused=True, windows_left=len(left), windows_loaded=loaded, loaded_back_to=back_to)
        if done and not any(int((snapshot.get(key) or {}).get("rows") or 0) for key in done):
            log.warning("audit: every audit window succeeded, but none had Copilot interaction records (%s to %s). "
                        "If people used Copilot then, check that the jobs' managed identity has %s (re-run the "
                        "installer to grant it), that auditing is on in Microsoft Purview (Audit), and that a "
                        "Purview audit search for the same hours, record type CopilotInteraction, finds records. "
                        "Empty windows are queried once more after they leave the look-back.",
                        min(ws for ws, _ in leaves), max(we for _, we in leaves), audit.AUDIT_ROLE)
        # Every window merged: a reload is done. Kept on a failed window, a failed merge, a paused run or a run
        # cut off, so the next run plans it again and `prune` keeps its windows. The same goes for re-queried empty
        # windows.
        self.clear_rechecks()
        with self._lock:
            reload_from = self.state.pop(BACKFILL_FROM, None)
            if self.state.pop("rebuild_when_loaded", None):
                self.state["full_rebuild_owed"] = True
                log.info("audit: the history is loaded; the curated tables are rebuilt once, as it was merged "
                         "newest first")
            self._save()
        if reload_from is not None:
            log.info("audit: the reload from %s is merged", reload_from)
        self.prune({audit.stable_window_key(ws, we) for ws, we in self.leaves(windows, include_parents=True)} | due)
        return result

    def _loaded_back_to(self, leaves):
        """How far back the merged history goes: the start of the oldest window in the newest unbroken run of merged
        ones. It reaches the reports when a run publishes (see `published` in the state)."""
        with self._lock:
            snapshot = dict(self.manifest)
        oldest = None
        for ws, we in sorted(leaves, key=lambda w: audit._as_utc_datetime(w[0]), reverse=True):
            entry = snapshot.get(audit.stable_window_key(ws, we)) or {}
            if entry.get("merged_at"):
                oldest = ws
            elif oldest is not None:
                break
        return _iso(oldest) if oldest is not None else None

    def merge(self, keys, advance_high_water=True) -> dict:
        """Merge the staged pages of the windows in `keys` into the day files, and mark those windows merged.

        `advance_high_water` moves the high-water mark, with what earlier runs merged while they held it. Without
        it the newest record merged is kept as `pending_high_water_mark` until a run merges every window.
        """
        files = sorted(rel for rel in self.store.list(STAGING) if _window_key(rel) in keys)
        passes, total, days, newest = [], 0, set(), None
        if not files:
            log.info("audit: no records in the window set")
        else:
            # Pages drained in this run are on disk already. An earlier run's are downloaded now, and only these.
            for rel in files:
                if not self.store.path(rel).is_file():
                    self.store.pull(rel)
            passes = self._passes(files)
            records, prompted = 0, 0
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

        def latest_of(*values):
            found = [audit._as_utc_datetime(v) for v in values if v]
            return max(found) if found else None

        with self._lock:
            if advance_high_water:
                mark = latest_of(self.state.get("high_water_mark"), newest,
                                 self.state.pop("pending_high_water_mark", None))
                if mark is not None:
                    self.state["high_water_mark"] = mark.isoformat()
            elif newest is not None:
                self.state["pending_high_water_mark"] = latest_of(self.state.get("pending_high_water_mark"),
                                                                  newest).isoformat()
            stamp = self._now().isoformat()
            for key in keys:
                if key in self.manifest:
                    self.manifest[key] = dict(self.manifest[key], merged_at=stamp)
            self._save()
        if files:
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


def remember_backfill(store, settings, now=None):
    """Record a requested reload in the state before any collector runs, so a run stopped early keeps it.

    The run job calls this first, as the audit collector runs last (see AuditCollector.remember_backfill). An older
    image's state gets its `published` record first (see AuditCollector.seed_published).
    """
    collector = AuditCollector(None, store, settings, now=now)
    collector.seed_published()
    collector.remember_backfill()
