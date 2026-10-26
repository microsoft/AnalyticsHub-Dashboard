"""Offline tests for `azure/jobs` (valuelens_jobs): collectors, publish, migrate, refresh, orchestration.

Graph and Power BI are faked at the HTTP-session level; Azure SQL is stood in for by sqlite3, which
accepts the bracket-quoted DDL/DML that publish emits.
"""
from __future__ import annotations

import gzip
import json
import sqlite3
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import duckdb
import pytest

from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import api as api_mod
from valuelens_jobs import publish as pub
from valuelens_jobs import refresh as refresh_mod
from valuelens_jobs import sql as sql_mod
from valuelens_jobs.collect import audit as audit_collect
from valuelens_jobs.collect import graph
from valuelens_jobs.config import Settings
from valuelens_jobs.storage import LocalStore
from valuelens_jobs.tables import write_rows

NOW = datetime(2026, 9, 10, 12, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------- fakes
class Resp:
    def __init__(self, status=200, body=None, text=None, headers=None, content=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.text = text if text is not None else (json.dumps(body) if body is not None else "")
        self.content = content if content is not None else self.text.encode("utf-8")

    def json(self):
        return self._body


class Session:
    """Routes (method, url-prefix) to a handler; records every call."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def request(self, method, url, headers=None, timeout=None, **kw):
        self.calls.append((method, url, kw, headers))
        return self.handler(method, url, kw)


class Tokens:
    def __init__(self):
        self.forced = 0

    def get(self, scope, force=False):
        self.forced += bool(force)
        return f"tok-{scope}"


def make_api(handler):
    session = Session(handler)
    return api_mod.Api(Tokens(), session=session, sleep=lambda s: None), session


def settings(**kw):
    base = dict(audit_history_days=1, audit_lookback_days=0, modules=frozenset({"core", "orgData", "m365Activity"}))
    base.update(kw)
    return Settings(**base)


# ---------------------------------------------------------------- api
def test_api_retries_throttling_and_refreshes_token_once():
    seq = [Resp(429, {}, headers={"Retry-After": "2"}), Resp(401, {}), Resp(200, {"ok": 1})]
    api, session = make_api(lambda m, u, kw: seq.pop(0))
    assert api.get("https://graph.microsoft.com/v1.0/x").json() == {"ok": 1}
    assert len(session.calls) == 3 and api.tokens.forced == 1
    assert session.calls[0][3]["Authorization"].startswith("Bearer ")


def test_token_source_caches_until_near_expiry():
    issued = []

    class Cred:
        def get_token(self, scope):
            issued.append(scope)
            return SimpleNamespace(token=f"t{len(issued)}", expires_on=1000)

    clock = [0]
    ts = api_mod.TokenSource(Cred(), clock=lambda: clock[0])
    assert ts.get("s") == ts.get("s") == "t1"
    clock[0] = 800
    assert ts.get("s") == "t2"


# ---------------------------------------------------------------- audit collector
def _record(i, when):
    return {
        "id": f"rec-{i}",
        "createdDateTime": when.isoformat().replace("+00:00", "Z"),
        "auditLogRecordType": "copilotInteraction",
        "operation": "CopilotInteraction",
        "userPrincipalName": "ada@contoso.com",
        "auditData": {"Id": f"aud-{i}", "CreationTime": when.strftime("%Y-%m-%dT%H:%M:%S"),
                      "UserId": "ada@contoso.com", "Operation": "CopilotInteraction",
                      "Workload": "Copilot", "RecordType": 261,
                      "CopilotEventData": {"AppHost": "Word", "Contexts": [],
                                           "Messages": [{"Id": f"m{i}", "isPrompt": True}]}},
    }


class AuditGraph:
    """Each created query returns the records whose time falls inside its window, in two pages.

    `status(ws, we, attempt)` scripts the final query status (e.g. "failed" on a window's first attempt).
    """

    def __init__(self, records, fail_first=0, status=None):
        self.records, self.queries, self.fail_first = records, {}, fail_first
        self.status, self.statuses, self.created = status or (lambda ws, we, n: "succeeded"), {}, []

    def __call__(self, method, url, kw):
        base = audit_collect.QUERIES
        if method == "POST" and url == base:
            if self.fail_first:
                self.fail_first -= 1
                return Resp(500, {"error": "boom"})
            body = kw["json"]
            qid = str(uuid.uuid4())
            ws, we = (datetime.fromisoformat(body[k]) for k in ("filterStartDateTime", "filterEndDateTime"))
            self.created.append((ws, we))
            self.statuses[qid] = self.status(ws, we, self.created.count((ws, we)))
            self.queries[qid] = [r for r in self.records
                                 if ws <= datetime.fromisoformat(r["createdDateTime"].replace("Z", "+00:00")) < we]
            return Resp(201, {"id": qid})
        qid = url[len(base) + 1:].split("/")[0].split("?")[0]
        if "/records" not in url:
            return Resp(200, {"status": self.statuses.get(qid, "succeeded")})
        recs = self.queries[qid]
        if "skip=1" in url:
            return Resp(200, {"value": recs[1:]})
        nxt = f"{base}/{qid}/records?$top=999&skip=1" if len(recs) > 1 else None
        page = {"value": recs[:1]}
        if nxt:
            page["@odata.nextLink"] = nxt
        return Resp(200, page)


def _parsed(store):
    return duckdb.sql(f"SELECT * FROM read_parquet('{(store.root / audit_collect.PARSED).as_posix()}/*.parquet', "
                      f"union_by_name=true) ORDER BY Id").fetchall(), \
        duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{(store.root / audit_collect.PARSED).as_posix()}/*.parquet')"
                   ).fetchall()


def test_audit_collect_merge_is_idempotent(tmp_path):
    t0 = NOW - timedelta(hours=20)
    records = [_record(1, t0), _record(2, t0 + timedelta(hours=1)), _record(3, NOW - timedelta(hours=2))]
    graph_fake = AuditGraph(records)
    api, _ = make_api(graph_fake)
    store = LocalStore(tmp_path)
    s = settings()
    first = audit_collect.collect_audit(api, store, s, now=NOW, sleep=lambda x: None)
    assert first["rows"] == 3
    rows, schema = _parsed(store)
    assert len(rows) == 3
    state = store.read_json(audit_collect.STATE)
    assert state["high_water_mark"].startswith(NOW.date().isoformat()) or state["high_water_mark"]
    assert all(w["status"] == "succeeded" for w in state["windows"].values())

    again = audit_collect.collect_audit(api, store, s, now=NOW + timedelta(minutes=5), sleep=lambda x: None)
    rows2, _ = _parsed(store)
    assert len(rows2) == 3 and again["rows"] <= 3


def test_audit_merge_reads_day_files_written_before_new_columns(tmp_path):
    # Upgrades keep the day files an older release wrote; merging into them must not need the newer columns.
    t0 = NOW - timedelta(hours=3)
    store = LocalStore(tmp_path)
    api, _ = make_api(AuditGraph([_record(1, t0)]))
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)["rows"] == 1
    dropped = ("AgentPlatform", "PlatformAgentId")
    files = list((store.root / audit_collect.PARSED).glob("*.parquet"))
    assert len(files) == 1
    for f in files:
        cols = [c for (c, *_) in duckdb.sql(f"DESCRIBE SELECT * FROM read_parquet('{f.as_posix()}')").fetchall()
                if c not in dropped]
        tmp = f.with_suffix(".old")
        duckdb.sql(f"COPY (SELECT {', '.join(cols)} FROM read_parquet('{f.as_posix()}')) TO '{tmp.as_posix()}' "
                   f"(FORMAT PARQUET)")
        tmp.replace(f)
    (store.root / audit_collect.STATE).unlink()

    api, _ = make_api(AuditGraph([_record(1, t0), _record(2, t0 + timedelta(hours=1))]))
    assert audit_collect.collect_audit(api, store, settings(), now=NOW + timedelta(minutes=5),
                                       sleep=lambda x: None)["rows"] >= 1
    assert len(list((store.root / audit_collect.PARSED).glob("*.parquet"))) == 1
    rows, schema = _parsed(store)
    assert len(rows) == 2
    assert {"AgentPlatform", "PlatformAgentId"} <= {c for (c, *_) in schema}


def test_audit_merge_logs_records_without_prompts(tmp_path, caplog):
    # Copilot Studio evaluations carry no messages and some events carry only responses; like every
    # variant they're not counted, but the run should say so rather than just "merged 0 rows".
    t0 = NOW - timedelta(hours=20)
    evaluation = _record(1, t0)
    evaluation["auditData"]["CopilotEventData"] = {"AppHost": "pva-maker-evaluation", "Messages": []}
    response_only = _record(2, t0 + timedelta(hours=1))
    response_only["auditData"]["CopilotEventData"]["Messages"] = [{"Id": "r2", "isPrompt": False}]
    api, _ = make_api(AuditGraph([evaluation, response_only, _record(3, t0 + timedelta(hours=2))]))
    store = LocalStore(tmp_path)
    with caplog.at_level("INFO", logger="valuelens_jobs.collect.audit"):
        result = audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)
    assert result["rows"] == 1
    assert "2 of 3 staged record(s) have no user prompt" in caplog.text


def test_audit_failed_window_raises_and_resumes(tmp_path):
    records = [_record(1, NOW - timedelta(hours=20)), _record(2, NOW - timedelta(hours=3))]
    api, _ = make_api(AuditGraph(records, fail_first=10**6))
    store = LocalStore(tmp_path)
    with pytest.raises(RuntimeError, match="audit window"):
        audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)
    assert not list((tmp_path / "raw").glob("copilot_interactions_parsed/*.parquet"))
    api, _ = make_api(AuditGraph(records))
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)["rows"] == 2


def test_audit_partial_failure_merges_finished_windows(tmp_path):
    """One throttled window must not leave the table empty, nor move the high-water mark past it."""
    records = [_record(1, NOW - timedelta(hours=20)), _record(2, NOW - timedelta(hours=3))]

    class OneBadWindow(AuditGraph):
        def __call__(self, method, url, kw):
            if method == "POST" and kw["json"]["filterStartDateTime"] == (NOW - timedelta(hours=20)).isoformat():
                return Resp(500, {"error": "boom"})
            return super().__call__(method, url, kw)

    api, _ = make_api(OneBadWindow(records))
    store = LocalStore(tmp_path)
    with pytest.raises(RuntimeError, match=r"1 audit window\(s\) failed; the 1 row\(s\)"):
        audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)
    rows, _ = _parsed(store)
    assert len(rows) == 1
    assert "high_water_mark" not in store.read_json(audit_collect.STATE)
    api, _ = make_api(AuditGraph(records))
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)["rows"] == 2
    assert store.read_json(audit_collect.STATE)["high_water_mark"]


def test_audit_permission_error_is_clear(tmp_path):
    api, _ = make_api(lambda m, u, kw: Resp(403, {"error": "forbidden"}))
    with pytest.raises(PermissionError, match="AuditLogsQuery.Read.All"):
        audit_collect.collect_audit(api, LocalStore(tmp_path), settings(), now=NOW, sleep=lambda x: None)


def test_audit_failed_query_is_resubmitted_and_succeeds(tmp_path):
    records = [_record(1, NOW - timedelta(hours=20)), _record(2, NOW - timedelta(hours=3))]
    fake = AuditGraph(records, status=lambda ws, we, n: "failed" if n == 1 else "succeeded")
    api, _ = make_api(fake)
    store = LocalStore(tmp_path)
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)["rows"] == 2
    windows = store.read_json(audit_collect.STATE)["windows"]
    assert len(windows) == 4 and all(w["status"] == "succeeded" and w["attempts"] == 2 for w in windows.values())
    assert all("ended with status: failed" in w["attempt_errors"][0] for w in windows.values())
    assert len(fake.created) == 8


def test_audit_persistent_failure_splits_window_and_merges_halves(tmp_path):
    records = [_record(1, NOW - timedelta(hours=20)), _record(2, NOW - timedelta(hours=13))]
    fake = AuditGraph(records, status=lambda ws, we, n: "failed" if we - ws == timedelta(hours=8) else "succeeded")
    api, _ = make_api(fake)
    store = LocalStore(tmp_path)
    collector = audit_collect.AuditCollector(api, store, settings(), now=NOW, sleep=lambda x: None,
                                             window_retries=1)
    assert collector.run()["rows"] == 2
    state = store.read_json(audit_collect.STATE)
    statuses = sorted(w["status"] for w in state["windows"].values())
    assert statuses == ["split"] * 3 + ["succeeded"] * 7
    parent = state["windows"][audit_collect.audit.stable_window_key(NOW - timedelta(hours=28), NOW - timedelta(hours=20))]
    assert len(parent["parts"]) == 2 and all(p in state["windows"] for p in parent["parts"])
    assert state["high_water_mark"]
    assert collector.limiter.limit == 4 and api.on_throttle is None
    # A rerun over the same range reuses the halves instead of querying the failing parents again.
    fake.status = lambda ws, we, n: "succeeded"
    rerun = audit_collect.AuditCollector(api, store, settings(), now=NOW, sleep=lambda x: None)
    leaves = rerun.leaves(audit_collect.audit.build_windows(NOW - timedelta(days=1), NOW, 8))
    assert len(leaves) == 7 and all(we - ws == timedelta(hours=4) for ws, we in leaves)


def test_audit_window_failing_at_minimum_size_holds_high_water_mark(tmp_path):
    records = [_record(1, NOW - timedelta(hours=20)), _record(2, NOW - timedelta(hours=3))]
    bad = NOW - timedelta(hours=28)
    fake = AuditGraph(records, status=lambda ws, we, n: "cancelled" if bad <= ws < bad + timedelta(hours=8) else "succeeded")
    api, _ = make_api(fake)
    store = LocalStore(tmp_path)
    with pytest.raises(RuntimeError, match=r"2 audit window\(s\) failed; the 2 row\(s\).*split down to 4h") as caught:
        audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None, window_retries=1,
                                    min_chunk_hours=4)
    assert "2026-09-09 08:00-12:00 UTC" in str(caught.value) and "2026-09-09 12:00-16:00 UTC" in str(caught.value)
    assert "high_water_mark" not in store.read_json(audit_collect.STATE)
    fake.status = lambda ws, we, n: "succeeded"
    before = len(fake.created)
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None, min_chunk_hours=4)["rows"] == 2
    assert sorted(we - ws for ws, we in fake.created[before:]) == [timedelta(hours=4)] * 2


def test_audit_throttling_halves_concurrency(tmp_path):
    fake = AuditGraph([_record(1, NOW - timedelta(hours=3))])
    throttled = [True]

    def handler(m, u, kw):
        if m == "POST" and throttled[0]:
            throttled[0] = False
            return Resp(429, {}, headers={"Retry-After": "1"})
        return fake(m, u, kw)

    api, _ = make_api(handler)
    collector = audit_collect.AuditCollector(api, LocalStore(tmp_path), settings(), now=NOW, sleep=lambda x: None,
                                             max_concurrent=6)
    assert collector.run()["rows"] == 1
    assert [h[:2] for h in collector.limiter.history] == [(6, 3)]
    assert api.on_throttle is None


def test_api_returns_a_429_at_once_when_its_retry_after_is_beyond_give_up_after():
    seq = [Resp(429, {}, headers={"Retry-After": "3600"}), Resp(200, {"ok": 1})]
    api, session = make_api(lambda m, u, kw: seq.pop(0))
    throttles = []
    api.on_throttle = lambda: throttles.append(1)
    assert api.get("https://graph.microsoft.com/v1.0/x", give_up_after=300).status_code == 429
    assert len(session.calls) == 1 and throttles == [1]
    assert "give_up_after" not in session.calls[0][2]
    # A short wait is still retried, and without give_up_after a long one is too (capped at 120 s).
    for retry in ("30", "3600"):
        seq[:] = [Resp(429, {}, headers={"Retry-After": retry}), Resp(200, {"ok": 1})]
        assert api.get("https://graph.microsoft.com/v1.0/x", give_up_after=None if retry == "3600" else 300).json() \
            == {"ok": 1}


class QuotaGraph(AuditGraph):
    """Accepts `allowed` new audit searches, then answers 429 with a day-long Retry-After."""

    def __init__(self, records, allowed, **kw):
        super().__init__(records, **kw)
        self.allowed, self.refused = allowed, 0

    def __call__(self, method, url, kw):
        if method == "POST" and url == audit_collect.QUERIES and len(self.created) >= self.allowed:
            self.refused += 1
            return Resp(429, {}, headers={"Retry-After": "3600"})
        return super().__call__(method, url, kw)


def test_audit_daily_search_limit_merges_finished_windows_and_resumes(tmp_path):
    records = [_record(i, NOW - timedelta(hours=27 - 8 * i)) for i in range(4)]  # one in each 8 h window
    fake = QuotaGraph(records, allowed=2)
    api, _ = make_api(fake)
    store = LocalStore(tmp_path)
    with pytest.raises(RuntimeError, match=r"refused new audit searches for this tenant \(HTTP 429\) with 2 audit "
                                           r"window\(s\) still to fetch\. The 2 row\(s\)"):
        audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None, max_concurrent=1)
    # One refusal, returned at once: no more searches are sent, and no new query is tried for that window.
    assert fake.refused == 1 and len(fake.created) == 2
    rows, _ = _parsed(store)
    assert len(rows) == 2
    state = store.read_json(audit_collect.STATE)
    assert "high_water_mark" not in state
    throttled = [w for w in state["windows"].values() if w["status"] == "waiting"]
    assert len(throttled) == 1 and throttled[0]["throttled_at"] and throttled[0]["query_id"] is None

    rerun = AuditGraph(records)
    api, _ = make_api(rerun)
    assert audit_collect.collect_audit(api, store, settings(), now=NOW + timedelta(minutes=5),
                                       sleep=lambda x: None)["rows"] >= 2
    assert len(rerun.created) == 2
    assert len(_parsed(store)[0]) == 4 and store.read_json(audit_collect.STATE)["high_water_mark"]


def test_audit_query_throttled_while_waiting_is_re_polled_by_the_next_run(tmp_path):
    records = [_record(1, NOW - timedelta(hours=3))]
    fake = AuditGraph(records)
    throttle_reads = [True]

    def handler(m, u, kw):
        if m == "GET" and "/records" not in u and throttle_reads[0]:
            return Resp(429, {}, headers={"Retry-After": "3600"})
        return fake(m, u, kw)

    api, _ = make_api(handler)
    store = LocalStore(tmp_path)
    with pytest.raises(RuntimeError, match="refused new audit searches"):
        audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None, max_concurrent=1)
    assert len(fake.created) == 1
    waiting = [w for w in store.read_json(audit_collect.STATE)["windows"].values() if w["status"] == "waiting"]
    assert len(waiting) == 1 and waiting[0]["query_id"] and waiting[0]["query_created_at"]

    throttle_reads[0] = False
    before = len(fake.created)
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)["rows"] == 1
    assert len(fake.created) - before == 3  # the other three windows; the waiting one re-polls its query
    assert store.read_json(audit_collect.STATE)["windows"][
        audit_collect.audit.stable_window_key(*fake.created[0])]["query_id"] == waiting[0]["query_id"]


class CappedGraph(AuditGraph):
    """Reports isRecordCountLimitExceeded for queries longer than `capped_hours`."""

    def __init__(self, records, capped_hours, **kw):
        super().__init__(records, **kw)
        self.capped_hours, self.spans = capped_hours, {}

    def __call__(self, method, url, kw):
        r = super().__call__(method, url, kw)
        if method == "POST":
            self.spans[r._body["id"]] = self.created[-1][1] - self.created[-1][0]
        elif "/records" not in url:
            qid = url[len(audit_collect.QUERIES) + 1:]
            r._body["isRecordCountLimitExceeded"] = self.spans[qid] > timedelta(hours=self.capped_hours)
        return r


def test_audit_record_limit_splits_the_window_at_once(tmp_path):
    records = [_record(1, NOW - timedelta(hours=20)), _record(2, NOW - timedelta(hours=13))]
    fake = CappedGraph(records, capped_hours=4)
    api, _ = make_api(fake)
    store = LocalStore(tmp_path)
    collector = audit_collect.AuditCollector(api, store, settings(), now=NOW, sleep=lambda x: None)
    assert collector.run()["rows"] == 2
    eight = [w for w in fake.created if w[1] - w[0] == timedelta(hours=8)]
    assert len(eight) == len(set(eight)) == 3  # each 8 h window queried once, not retried
    # Their halves, plus the last window (08:00-12:00), which is 4 h already.
    assert sum(1 for w in fake.created if w[1] - w[0] == timedelta(hours=4)) == 7
    assert collector.limiter.history == []
    windows = store.read_json(audit_collect.STATE)["windows"].values()
    assert sum(1 for w in windows if w["status"] == "split") == 3
    assert not any(w.get("record_limit_exceeded") for w in windows)


def test_audit_record_limit_at_the_smallest_window_is_kept_and_flagged(tmp_path, caplog):
    fake = CappedGraph([_record(1, NOW - timedelta(hours=3))], capped_hours=4)
    api, _ = make_api(fake)
    store = LocalStore(tmp_path)
    with caplog.at_level("WARNING", logger="valuelens_jobs.collect.audit"):
        assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None,
                                           min_chunk_hours=8)["rows"] == 1
    assert len(fake.created) == 4
    windows = store.read_json(audit_collect.STATE)["windows"].values()
    assert all(w["status"] == "succeeded" for w in windows)
    assert sum(1 for w in windows if w.get("record_limit_exceeded")) == 3  # not the 4 h window at the end
    assert "some of its records are missing" in caplog.text


def test_audit_retry_classification():
    assert audit_collect.is_retryable(audit_collect.AuditQueryFailed("failed"))
    assert audit_collect.is_retryable(TimeoutError("slow"))
    assert audit_collect.is_retryable(api_mod.HttpError("x: HTTP 503", 503))
    assert not audit_collect.is_retryable(api_mod.HttpError("x: HTTP 400", 400))
    assert not audit_collect.is_retryable(RuntimeError("bad next link"))


def test_audit_rejects_foreign_next_link(tmp_path):
    fake = AuditGraph([_record(1, NOW - timedelta(hours=3)), _record(2, NOW - timedelta(hours=2))])

    def handler(m, u, kw):
        r = fake(m, u, kw)
        if isinstance(r._body, dict) and "@odata.nextLink" in r._body:
            r._body["@odata.nextLink"] = "https://evil.example/records"
        return r

    api, _ = make_api(handler)
    with pytest.raises(RuntimeError, match="audit window"):
        audit_collect.collect_audit(api, LocalStore(tmp_path), settings(), now=NOW, sleep=lambda x: None)


class ReplicaStopped(BaseException):
    """The run job stopping a replica at its 4 h limit: not an Exception, so nothing in the collector
    catches it and the windows it hadn't finished stay unfinished in the manifest."""


def test_audit_first_collection_resumes_across_runs(tmp_path):
    # A large tenant's first collection can outlast one run. The next run must query only the windows the
    # stopped one didn't finish, then merge everything.
    s = settings(audit_history_days=3, audit_lookback_days=1)
    records = [_record(i, NOW - timedelta(hours=75 - 8 * i)) for i in range(10)]  # one in each 8 h window

    class StopsAfterFourWindows(AuditGraph):
        def __call__(self, method, url, kw):
            if method == "POST" and len(self.created) >= 4:
                raise ReplicaStopped()
            return super().__call__(method, url, kw)

    store = LocalStore(tmp_path)
    api, _ = make_api(StopsAfterFourWindows(records))
    with pytest.raises(ReplicaStopped):
        audit_collect.collect_audit(api, store, s, now=NOW, sleep=lambda x: None, max_concurrent=1)
    state = store.read_json(audit_collect.STATE)
    done = {k for k, w in state["windows"].items() if w["status"] == "succeeded"}
    assert len(done) == 4 and "high_water_mark" not in state
    assert not list((store.root / audit_collect.PARSED).glob("*.parquet"))

    rerun = AuditGraph(records)
    api, _ = make_api(rerun)
    assert audit_collect.collect_audit(api, store, s, now=NOW + timedelta(hours=1), sleep=lambda x: None)["rows"] == 10
    queried = {audit_collect.audit.stable_window_key(ws, we) for ws, we in rerun.created}
    assert len(queried) == 6 and not queried & done
    rows, _ = _parsed(store)
    assert len(rows) == 10
    state = store.read_json(audit_collect.STATE)
    assert state["high_water_mark"] and all(w["status"] == "succeeded" for w in state["windows"].values())


def test_audit_merge_in_passes_writes_what_one_pass_writes(tmp_path, caplog):
    # A long backfill merges in passes of whole days, so the run job holds one pass in memory at a time.
    # Rows replace rows by Id, so the day files and the high-water mark must match a single pass.
    s = settings(audit_history_days=3, audit_lookback_days=1)
    records = [_record(i, NOW - timedelta(hours=70 - 7 * i)) for i in range(10)]  # across 4 days
    late = _record(9, NOW - timedelta(hours=7))
    late["auditData"]["CopilotEventData"]["AppHost"] = "Excel"
    stores = {"one": LocalStore(tmp_path / "one"), "passes": LocalStore(tmp_path / "passes")}
    budgets = {"one": audit_collect.MERGE_PASS_RECORDS, "passes": 1}

    def collect(name, recs, now):
        api, _ = make_api(AuditGraph(recs))
        return audit_collect.collect_audit(api, stores[name], s, now=now, sleep=lambda x: None,
                                           merge_pass_records=budgets[name])

    def written(name):
        store = stores[name]
        return (sorted(p.name for p in (store.root / audit_collect.PARSED).glob("*.parquet")), _parsed(store),
                store.read_json(audit_collect.STATE)["high_water_mark"])

    with caplog.at_level("INFO", logger="valuelens_jobs.collect.audit"):
        assert collect("one", records, NOW) == collect("passes", records, NOW) == {"rows": 10, "days": 4}
    assert "merged 10 row(s) across 4 day file(s) in 4 passes" in caplog.text
    first = written("one")
    assert written("passes") == first and len(first[0]) == 4

    # The next run re-queries the look-back and replaces the changed row inside the existing day files.
    later = NOW + timedelta(hours=1)
    assert collect("one", records[:9] + [late], later) == collect("passes", records[:9] + [late], later)
    assert written("passes") == written("one") != first
    assert len(written("passes")[1][0]) == 10


def test_audit_merge_failing_part_way_holds_everything_for_the_next_run(tmp_path, monkeypatch):
    # A merge can fail between passes (out of memory, a full disk). Until it finishes, the high-water mark holds,
    # the windows stay finished and nothing is pruned, so the next run re-merges them without querying again and
    # writes what one clean run writes.
    s = settings(audit_history_days=3)
    hw = (NOW - timedelta(days=3)).isoformat()
    records = [_record(i, NOW - timedelta(hours=60 - 6 * i)) for i in range(10)]  # across 3 days
    old = NOW - timedelta(days=30)
    stale = audit_collect.audit.stable_window_key(old, old + timedelta(hours=8))
    page = f"{audit_collect.STAGING}/win_{stale}_0000.jsonl.gz"

    def seeded(name):
        # The last run, 3 days ago, left a window the next finished run prunes.
        store = LocalStore(tmp_path / name)
        store.path(page).parent.mkdir(parents=True)
        with gzip.open(store.path(page), "wt", encoding="utf-8") as fh:
            fh.write(json.dumps(audit_collect.audit.canonicalize_audit_record(_record(99, old))) + "\n")
        store.write_json(audit_collect.STATE, {"high_water_mark": hw, "windows": {stale: {
            "status": "succeeded", "rows": 1, "pages": 1, "files": [page.split("/")[-1]],
            "completed_at": old.isoformat()}}})
        return store

    def collect(store, graph_fake, budget=1):
        api, _ = make_api(graph_fake)
        return audit_collect.collect_audit(api, store, s, now=NOW, sleep=lambda x: None, merge_pass_records=budget)

    def written(store):
        return (sorted(p.name for p in (store.root / audit_collect.PARSED).glob("*.parquet")), _parsed(store),
                store.read_json(audit_collect.STATE)["high_water_mark"])

    clean = seeded("clean")
    assert collect(clean, AuditGraph(records), budget=audit_collect.MERGE_PASS_RECORDS) == {"rows": 10, "days": 3}

    real, passes = audit_collect.AuditCollector._merge_pass, []

    def out_of_memory_in_the_second_of_three_passes(self, files, spill):
        passes.append(files)
        if len(passes) == 2:
            raise duckdb.OutOfMemoryException("Out of Memory Error: could not allocate block")
        return real(self, files, spill)

    store = seeded("failing")
    monkeypatch.setattr(audit_collect.AuditCollector, "_merge_pass", out_of_memory_in_the_second_of_three_passes)
    with pytest.raises(duckdb.OutOfMemoryException):
        collect(store, AuditGraph(records))
    assert len(passes) == 2
    state = store.read_json(audit_collect.STATE)
    assert state["high_water_mark"] == hw
    assert len(state["windows"]) > 1 and all(w["status"] == "succeeded" for w in state["windows"].values())
    assert stale in state["windows"] and store.path(page).is_file()
    assert [p.name for p in (store.root / audit_collect.PARSED).glob("*.parquet")] == ["day-20260908.parquet"]

    monkeypatch.undo()
    rerun = AuditGraph(records)
    assert collect(store, rerun) == {"rows": 10, "days": 3}
    assert rerun.created == []
    assert written(store) == written(clean)
    assert stale not in store.read_json(audit_collect.STATE)["windows"] and not store.path(page).exists()


def test_audit_pages_are_staged_compressed_and_uncompressed_pages_still_merge(tmp_path):
    store = LocalStore(tmp_path)
    api, _ = make_api(AuditGraph([_record(1, NOW - timedelta(hours=2))]))
    collector = audit_collect.AuditCollector(api, store, settings(), now=NOW, sleep=lambda x: None)
    assert collector.run()["rows"] == 1
    staged = store.list(audit_collect.STAGING)
    assert staged and all(rel.endswith(".jsonl.gz") for rel in staged)
    with gzip.open(store.path(staged[0]), "rt", encoding="utf-8") as fh:
        assert json.loads(fh.readline())["RecordId"] == "rec-1"

    # A page an earlier release staged uncompressed still merges alongside the compressed ones.
    ws = NOW - timedelta(hours=52)
    old_key = audit_collect.audit.stable_window_key(ws, ws + timedelta(hours=8))
    record = audit_collect.audit.canonicalize_audit_record(_record(2, ws + timedelta(hours=1)))
    old = store.path(f"{audit_collect.STAGING}/win_{old_key}_0000.jsonl")
    old.write_text(json.dumps(record) + "\n", encoding="utf-8")
    assert collector.merge({old_key, audit_collect._window_key(staged[0])}) == {"rows": 2, "days": 2}
    rows, _ = _parsed(store)
    assert len(rows) == 2


def test_audit_merge_caps_duckdb_and_spills_to_a_temp_folder(tmp_path, monkeypatch):
    # DuckDB's default spill folder is `.tmp` in the working directory, which the job's user can't create.
    executed, connections = [], []

    class Recording:
        def __init__(self, con):
            self._con = con

        def execute(self, sql, *args):
            executed.append(sql)
            return self._con.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self._con, name)

    def connect(*args, **kwargs):
        connections.append(Recording(duckdb.connect(*args, **kwargs)))
        return connections[-1]

    monkeypatch.setattr(audit_collect, "duckdb", SimpleNamespace(connect=connect))
    monkeypatch.setenv("VALUELENS_DUCKDB_MEMORY_LIMIT", "1GiB")
    records = [_record(1, NOW - timedelta(hours=30)), _record(2, NOW - timedelta(hours=2))]  # two days
    api, _ = make_api(AuditGraph(records))
    assert audit_collect.collect_audit(api, LocalStore(tmp_path / "capped"), settings(audit_history_days=2),
                                       now=NOW, sleep=lambda x: None, merge_pass_records=1)["rows"] == 2
    assert len(connections) == 2
    assert executed.count("SET memory_limit = '1GiB'") == 2
    spills = {sql for sql in executed if sql.startswith("SET temp_directory")}
    assert len(spills) == 1 and "valuelens-duckdb-" in next(iter(spills))
    assert not Path(next(iter(spills)).split("'")[1]).exists()

    monkeypatch.delenv("VALUELENS_DUCKDB_MEMORY_LIMIT")
    executed.clear()
    api, _ = make_api(AuditGraph(records))
    assert audit_collect.collect_audit(api, LocalStore(tmp_path / "default"), settings(audit_history_days=2),
                                       now=NOW, sleep=lambda x: None)["rows"] == 2
    assert any(sql.startswith("SET temp_directory") for sql in executed)
    assert not any(sql.startswith("SET memory_limit") for sql in executed)


def test_collect_audit_frees_the_local_staging_copy_after_each_run(tmp_path):
    # `process` runs next on the same disk; the staged pages stay in storage for the next run.
    class Store(LocalStore):
        def evict(self, prefix):
            self.evicted.append(prefix)

    store = Store(tmp_path)
    store.evicted = []
    records = [_record(1, NOW - timedelta(hours=2))]
    api, _ = make_api(AuditGraph(records, fail_first=10**6))
    with pytest.raises(RuntimeError, match="audit window"):
        audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None, window_retries=0,
                                    min_chunk_hours=8)
    assert store.evicted == [audit_collect.STAGING]
    api, _ = make_api(AuditGraph(records))
    assert audit_collect.collect_audit(api, store, settings(), now=NOW, sleep=lambda x: None)["rows"] == 1
    assert store.evicted == [audit_collect.STAGING] * 2


# ---------------------------------------------------------------- graph snapshots
LICENSED_CSV = ("\ufeffReport Refresh Date,User Principal Name,Display Name,Assigned Products\n"
                "2026-09-09,Ada@contoso.com,Ada,MICROSOFT 365 E5+MICROSOFT 365 COPILOT\n"
                "2026-09-09,bob@contoso.com,Bob,Microsoft 365 E3\n")
COPILOT_CSV = "\ufeffReport Refresh Date,User Principal Name,Display Name,Last Activity Date\n"


def test_collect_licensed_and_org(tmp_path):
    users_page2 = graph.org.USERS_URL + "&$skiptoken=2"

    def handler(m, url, kw):
        if "getOffice365ActiveUserDetail" in url:
            return Resp(200, text=LICENSED_CSV, content=LICENSED_CSV.encode("utf-8-sig"))
        if url == graph.COPILOT_USAGE_URL:
            return Resp(200, text=COPILOT_CSV, content=COPILOT_CSV.encode())
        if url == graph.org.USERS_URL:
            return Resp(200, {"value": [{"userPrincipalName": "ceo@contoso.com", "displayName": "Ceo"}],
                              "@odata.nextLink": users_page2})
        if url == users_page2:
            return Resp(200, {"value": [{"userPrincipalName": "ada@contoso.com", "displayName": "Ada",
                                         "manager": {"userPrincipalName": "ceo@contoso.com"}}]})
        raise AssertionError(url)

    api, _ = make_api(handler)
    store = LocalStore(tmp_path)
    assert graph.collect_licensed(api, store, settings()) == 2
    assert graph.collect_org(api, store, settings()) == 2
    lic = duckdb.sql(f"SELECT UPN_Normalized, Has_license FROM '{store.path('raw/copilot_licensed_users/part-0.parquet').as_posix()}' ORDER BY 1").fetchall()
    assert lic == [("ada@contoso.com", "TRUE"), ("bob@contoso.com", "FALSE")]
    org_rows = duckdb.sql(f"SELECT count(*) FROM '{store.path('raw/copilot_org_data/part-0.parquet').as_posix()}'").fetchone()
    assert org_rows == (2,)


def test_collect_org_keeps_manager_cycles_and_warns(tmp_path, caplog):
    users = [{"userPrincipalName": "a@contoso.com", "manager": {"userPrincipalName": "b@contoso.com"}},
             {"userPrincipalName": "b@contoso.com", "manager": {"userPrincipalName": "a@contoso.com"}},
             {"userPrincipalName": "top@contoso.com", "manager": {"userPrincipalName": "top@contoso.com"}}]
    api, _ = make_api(lambda m, u, kw: Resp(200, {"value": users}))
    store = LocalStore(tmp_path)
    with caplog.at_level("WARNING", logger="valuelens_jobs.collect"):
        assert graph.collect_org(api, store, settings()) == 3
    assert "2 distinct manager cycle(s)" in caplog.text
    rows = duckdb.sql(f"SELECT PersonId, HierarchyError FROM '{store.path('raw/copilot_org_data/part-0.parquet').as_posix()}' ORDER BY 1").fetchall()
    assert rows == [("a@contoso.com", "Cycle detected at 'a@contoso.com'"),
                    ("b@contoso.com", "Cycle detected at 'b@contoso.com'"),
                    ("top@contoso.com", "")]


def test_collect_org_logs_department_coverage(tmp_path, caplog):
    users = [{"userPrincipalName": "a@contoso.com", "department": "Sales"},
             {"userPrincipalName": "b@contoso.com", "department": "  "},
             {"userPrincipalName": "c@contoso.com"}]
    api, _ = make_api(lambda m, u, kw: Resp(200, {"value": users}))
    with caplog.at_level("INFO", logger="valuelens_jobs.collect"):
        assert graph.collect_org(api, LocalStore(tmp_path), settings()) == 3
    warning = [r for r in caplog.records if "have a department" in r.getMessage()]
    assert [r.levelname for r in warning] == ["WARNING"]
    assert "1 of 3 people have a department" in warning[0].getMessage()
    assert "Microsoft Entra ID" in warning[0].getMessage()


def test_collect_org_rejects_loops_and_foreign_links(tmp_path):
    api, _ = make_api(lambda m, u, kw: Resp(200, {"value": [], "@odata.nextLink": graph.org.USERS_URL}))
    with pytest.raises(RuntimeError, match="looped"):
        graph.collect_org(api, LocalStore(tmp_path), settings())
    api, _ = make_api(lambda m, u, kw: Resp(200, {"value": [], "@odata.nextLink": "https://evil.example/u"}))
    with pytest.raises(RuntimeError, match="non-Graph"):
        graph.collect_org(api, LocalStore(tmp_path), settings())


def test_collect_licensed_403_names_permission(tmp_path):
    api, _ = make_api(lambda m, u, kw: Resp(403, {}))
    with pytest.raises(PermissionError, match="Reports.Read.All"):
        graph.collect_licensed(api, LocalStore(tmp_path), settings())


def _licensed_flags(store):
    path = store.path('raw/copilot_licensed_users/part-0.parquet').as_posix()
    return duckdb.sql(f"SELECT UPN_Normalized, Has_license FROM '{path}' ORDER BY 1").fetchall()


def _licensed_api(copilot):
    def handler(m, url, kw):
        if "getOffice365ActiveUserDetail" in url:
            return Resp(200, text=LICENSED_CSV, content=LICENSED_CSV.encode("utf-8-sig"))
        if url == graph.COPILOT_USAGE_URL:
            return copilot
        raise AssertionError(url)
    return make_api(handler)[0]


def test_collect_licensed_counts_users_in_copilot_report(tmp_path, caplog):
    text = COPILOT_CSV + "2026-09-09,BOB@contoso.com,Bob,\n2026-09-09,ada@contoso.com,Ada,2026-09-08\n"
    store = LocalStore(tmp_path)
    with caplog.at_level("INFO", logger="valuelens_jobs.collect"):
        assert graph.collect_licensed(_licensed_api(Resp(200, text=text, content=text.encode("utf-8-sig"))),
                                      store, settings()) == 2
    assert _licensed_flags(store) == [("ada@contoso.com", "TRUE"), ("bob@contoso.com", "TRUE")]
    assert "1 by product and report, 0 by product only, 1 by Copilot report only" in caplog.text
    assert "concealed" not in caplog.text


@pytest.mark.parametrize("status", [400, 403, 404])
def test_collect_licensed_falls_back_when_copilot_report_unavailable(tmp_path, caplog, status):
    store = LocalStore(tmp_path)
    with caplog.at_level("WARNING", logger="valuelens_jobs.collect"):
        assert graph.collect_licensed(_licensed_api(Resp(status, {})), store, settings()) == 2
    assert _licensed_flags(store) == [("ada@contoso.com", "TRUE"), ("bob@contoso.com", "FALSE")]
    assert f"returned HTTP {status}" in caplog.text


def test_collect_licensed_keeps_old_snapshot_when_copilot_report_fails(tmp_path):
    store = LocalStore(tmp_path)
    graph.collect_licensed(_licensed_api(Resp(200, text=COPILOT_CSV, content=COPILOT_CSV.encode())), store, settings())
    before = _licensed_flags(store)
    with pytest.raises(Exception, match="Copilot usage report"):
        graph.collect_licensed(_licensed_api(Resp(502, {})), store, settings())
    assert _licensed_flags(store) == before


def test_collect_licensed_warns_when_copilot_report_names_differ(tmp_path, caplog):
    text = COPILOT_CSV + "2026-09-09,E58EEF6A6BBD3D0293CB306D24A42057,6A46,\n"
    with caplog.at_level("WARNING", logger="valuelens_jobs.collect"):
        graph.collect_licensed(_licensed_api(Resp(200, text=text, content=text.encode())), LocalStore(tmp_path),
                               settings())
    assert "none of the 1 users in the Copilot usage report" in caplog.text
    assert "concealed" in caplog.text


def test_collect_m365_writes_day_files(tmp_path):
    csv = ("Report Refresh Date,User Principal Name,Team Chat Message Count\n"
           "2026-09-08,Ada@contoso.com,4\n")

    def handler(m, url, kw):
        if "getTeamsUserActivityUserDetail" in url:
            return Resp(200, text=csv, content=csv.encode())
        return Resp(404, {})

    api, _ = make_api(handler)
    store = LocalStore(tmp_path)
    out = graph.collect_m365(api, store, settings(), today=date(2026, 9, 10), reread_days=2)
    assert out["written"]
    files = sorted(p.name for p in (tmp_path / "raw" / "m365_activity_daily").glob("*.parquet"))
    assert files == [f"day-{d:%Y%m%d}.parquet" for d in out["written"]]


def test_collect_m365_records_reports_with_no_app_usage(tmp_path, caplog):
    teams = ("Report Refresh Date,User Principal Name,Team Chat Message Count\n"
             "2026-09-08,Ada@contoso.com,4\n")
    apps = ("Report Refresh Date,User Principal Name,Word,Excel,Windows\n"
            "2026-09-08,Ada@contoso.com,No,No,No\n2026-09-08,Bo@contoso.com,,,\n")

    def handler(m, url, kw):
        if "getTeamsUserActivityUserDetail" in url:
            return Resp(200, text=teams, content=teams.encode())
        if "getM365AppUserDetail" in url:
            return Resp(200, text=apps, content=apps.encode())
        return Resp(404, {})

    api, _ = make_api(handler)
    store = LocalStore(tmp_path)
    with caplog.at_level("INFO", logger="valuelens_jobs.collect"):
        out = graph.collect_m365(api, store, settings(), today=date(2026, 9, 10), reread_days=2)
    day = out["written"][0]
    by_report = {r[1]: r for r in out["status"] if r[0] == day}
    assert by_report["teams"][3:6] == ("ok", 1, 1)
    assert by_report["apps"][3:6] == ("no_activity", 2, 0)
    assert by_report["email"][3:6] == ("unavailable", 0, 0)
    assert "apps report no_activity (2 row(s), 0 with use)" in caplog.text
    path = store.path(graph.m365_status_file(day)).as_posix()
    rows = duckdb.sql(f"SELECT Report, Status, Rows, ActiveRows FROM '{path}' ORDER BY Report").fetchall()
    assert ("apps", "no_activity", 2, 0) in rows and len(rows) == len(graph.m365.REPORTS)


# ---------------------------------------------------------------- publish
def _write_curated(store, rows, extra_col=False):
    cols = ["Id", "InteractionDate", "UserUPN", "Prompts"] + (["NewCol"] if extra_col else [])
    types = ["VARCHAR", "DATE", "VARCHAR", "BIGINT"] + (["VARCHAR"] if extra_col else [])
    write_rows(store.path("curated/copilot_interactions_curated/part-0.parquet"), cols,
               [r + (("x",) if extra_col else ()) for r in rows], types)


def test_publish_partitions_are_incremental(tmp_path):
    store = LocalStore(tmp_path)
    conn = sqlite3.connect(":memory:")
    d1, d2 = date(2026, 9, 1), date(2026, 9, 2)
    _write_curated(store, [("a", d1, "ada", 1), ("b", d2, "bob", 2)])
    r = pub.publish(conn, store, ["curated"])[0]
    assert r["days_changed"] == 2 and r["rows"] == 2

    r = pub.publish(conn, store, ["curated"])[0]
    assert r["days_changed"] == 0 and r["rows"] == 0

    _write_curated(store, [("a", d1, "ada", 1), ("b2", d2, "bob", 5), ("c", d2, "cy", 1)], extra_col=True)
    r = pub.publish(conn, store, ["curated"])[0]
    assert r["added_columns"] == ["NewCol"]
    assert r["days_changed"] == 2  # schema change re-signs every day
    got = conn.execute("SELECT Id, InteractionDate, NewCol FROM copilot_interactions_curated ORDER BY Id").fetchall()
    assert got == [("a", "2026-09-01", "x"), ("b2", "2026-09-02", "x"), ("c", "2026-09-02", "x")]

    _write_curated(store, [("b2", d2, "bob", 5), ("c", d2, "cy", 1)], extra_col=True)
    r = pub.publish(conn, store, ["curated"])[0]
    assert r["days_removed"] == 1 and r["days_changed"] == 0
    assert r["oldest_day"] == "2026-09-01"
    assert conn.execute("SELECT count(*) FROM copilot_interactions_curated").fetchone() == (2,)
    assert pub.publish(conn, store, ["curated"])[0]["oldest_day"] is None


def test_publish_snapshot_replaces_and_skips_missing(tmp_path):
    store = LocalStore(tmp_path)
    conn = sqlite3.connect(":memory:")
    assert pub.publish(conn, store, ["org"])[0]["skipped"]
    write_rows(store.path("raw/copilot_licensed_users/part-0.parquet"), ["UPN_Normalized", "Has_license"],
               [("a", "TRUE"), ("b", "FALSE")])
    pub.publish(conn, store, ["licensed"])
    write_rows(store.path("raw/copilot_licensed_users/part-0.parquet"), ["UPN_Normalized", "Has_license"],
               [("a", "TRUE")])
    assert pub.publish(conn, store, ["licensed"])[0]["rows"] == 1
    assert conn.execute("SELECT * FROM copilot_licensed_users").fetchall() == [("a", "TRUE")]


def test_publish_type_mapping():
    assert pub.sql_type("VARCHAR") == "NVARCHAR(4000)"
    assert pub.sql_type("TIMESTAMP WITH TIME ZONE") == pub.TYPE_MAP["TIMESTAMP"]
    assert pub.sql_type("DECIMAL(18,2)") == "DECIMAL(18,2)"
    assert pub.b("a]b") == "[a]]b]"


# ---------------------------------------------------------------- migrate
def test_migration_discovery_and_batches(tmp_path):
    (tmp_path / "V002__more.sql").write_text("SELECT 2\nGO\n", encoding="utf-8")
    (tmp_path / "V001__init.sql").write_text("CREATE TABLE t (a INT)\n  go  \nSELECT 1\nGO", encoding="utf-8")
    (tmp_path / "README.md").write_text("x", encoding="utf-8")
    assert [v for v, _ in sql_mod.migrations(tmp_path)] == [1, 2]
    assert sql_mod.batches((tmp_path / "V001__init.sql").read_text()) == ["CREATE TABLE t (a INT)", "SELECT 1"]
    (tmp_path / "V1__dup.sql").write_text("", encoding="utf-8")
    with pytest.raises(ValueError, match="Duplicate"):
        sql_mod.migrations(tmp_path)


def test_migrate_applies_once(tmp_path):
    (tmp_path / "V001__init.sql").write_text(
        "CREATE TABLE schema_version (version INT, description TEXT, applied_at TEXT)\nGO\n"
        "CREATE TABLE t (a INT)\nGO\n", encoding="utf-8")
    (tmp_path / "V002__add.sql").write_text("ALTER TABLE t ADD b INT\n", encoding="utf-8")

    class Conn:
        """sqlite3 with `dbo.` stripped and T-SQL `IF NOT EXISTS ... INSERT` emulated."""

        def __init__(self):
            self.db = sqlite3.connect(":memory:")

        def cursor(self):
            db = self.db

            class Cur:
                def execute(self, stmt, params=()):
                    stmt = stmt.replace("dbo.", "")
                    if stmt.startswith("IF NOT EXISTS"):
                        v, v2, d = params
                        if not db.execute("SELECT 1 FROM schema_version WHERE version = ?", (v,)).fetchone():
                            db.execute("INSERT INTO schema_version (version, description) VALUES (?, ?)", (v2, d))
                        return
                    self.c = db.execute(stmt, params)

                def fetchall(self):
                    return self.c.fetchall()
            return Cur()

        def commit(self):
            self.db.commit()

        def rollback(self):
            self.db.rollback()

    conn = Conn()
    assert sql_mod.migrate(conn, tmp_path) == [1, 2]
    assert sql_mod.migrate(conn, tmp_path) == []
    assert conn.db.execute("SELECT version, description FROM schema_version ORDER BY 1").fetchall() == \
        [(1, "init"), (2, "add")]


def test_reader_sid_and_statements():
    cid = "11223344-5566-7788-99aa-bbccddeeff00"
    assert sql_mod.sid_literal(cid) == "0x44332211665588779" "9AABBCCDDEEFF00"
    stmts = sql_mod.reader_statements("ValueLens ]Reader'", cid)
    assert "CREATE USER [ValueLens ]]Reader'] WITH SID = 0x" in stmts[0]
    assert "N'ValueLens ]Reader'''" in stmts[0]
    assert stmts[1].endswith("ALTER ROLE db_datareader ADD MEMBER [ValueLens ]]Reader']")
    assert sql_mod.reader_statements("", cid) == []
    with pytest.raises(ValueError):
        sql_mod.sid_literal("not-a-guid")


def test_access_token_struct():
    packed = sql_mod.access_token_struct("ab")
    assert packed == b"\x04\x00\x00\x00a\x00b\x00"


def test_repo_migrations_parse():
    found = sql_mod.migrations(sql_mod.default_migrations_dir())
    assert found and found[0][0] == 1
    for _, path in found:
        assert sql_mod.batches(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- refresh
WS, DS = "ws-1", "ds-1"
REFRESHES = f"{refresh_mod.BASE}/groups/{WS}/datasets/{DS}/refreshes"


def _refresher(handler):
    api, session = make_api(handler)
    clock = [0.0]

    def sleep(s):
        clock[0] += s

    return refresh_mod.Refresher(api, sleep=sleep, clock=lambda: clock[0]), session


def test_refresh_enhanced_waits_out_busy_then_polls():
    state = {"posts": 0, "polls": 0}

    def handler(m, url, kw):
        if m == "POST":
            state["posts"] += 1
            if state["posts"] == 1:
                return Resp(409, text="Another refresh is in progress")
            return Resp(202, headers={"Location": f"{REFRESHES}/rid-9", "RequestId": "req"})
        assert url == f"{REFRESHES}/rid-9"
        state["polls"] += 1
        if state["polls"] <= 2:  # Power BI answers 202 while the refresh is in progress
            return Resp(202, {"status": "Unknown", "extendedStatus": "NotStarted" if state["polls"] == 1 else "InProgress"})
        return Resp(200, {"extendedStatus": "Completed"})

    r, session = _refresher(handler)
    r.refresh(WS, DS)
    assert state == {"posts": 2, "polls": 3}
    assert session.calls[1][2]["json"] == refresh_mod.ENHANCED


def test_refresh_pro_falls_back_to_standard_and_reads_history():
    bodies = []

    def handler(m, url, kw):
        if m == "POST":
            bodies.append(kw["json"])
            if kw["json"] is refresh_mod.ENHANCED:
                return Resp(400, text="enhanced refresh needs premium")
            return Resp(202, headers={"RequestId": "req-7"})
        assert kw["params"] == {"$top": 10}
        return Resp(200, {"value": [{"requestId": "other", "status": "Failed"},
                                    {"requestId": "req-7", "status": "Completed"}]})

    r, _ = _refresher(handler)
    r.refresh(WS, DS)
    assert bodies == [refresh_mod.ENHANCED, refresh_mod.STANDARD]


def test_refresh_reloads_all_partitions_when_old_days_were_republished():
    today = date(2026, 10, 7)
    recent = [{"oldest_day": "2026-09-30"}, {"oldest_day": None}, {"table": "x"}]
    assert not refresh_mod.needs_full_refresh(recent, today)
    assert not refresh_mod.needs_full_refresh(None, today)
    assert refresh_mod.needs_full_refresh(recent + [{"oldest_day": "2026-09-29"}], today)

    # M365 Activity's policy reloads 35 days, so the 28 days its collector can rewrite stay incremental.
    m365 = {"table": "m365_activity_daily"}
    assert not refresh_mod.needs_full_refresh([{**m365, "oldest_day": "2026-09-09"}], today)
    assert not refresh_mod.needs_full_refresh([{**m365, "oldest_day": "2026-09-02"}], today)
    assert refresh_mod.needs_full_refresh([{**m365, "oldest_day": "2026-09-01"}], today)
    assert refresh_mod.needs_full_refresh([{**m365, "oldest_day": "2026-09-09"},
                                           {"table": "copilot_interactions_curated", "oldest_day": "2026-09-29"}], today)
    installer = (Path(__file__).resolve().parents[1] / "installer" / "src" / "transform" / "m365.js").read_text(encoding="utf-8")
    rewrite = int(installer.split("M365_REWRITE_DAYS = ", 1)[1].split(";", 1)[0])
    assert "incrementalPeriods: M365_REWRITE_DAYS + 7," in installer
    assert refresh_mod.INCREMENTAL_DAYS_BY_TABLE["m365_activity_daily"] == rewrite + 7

    bodies = []

    def handler(m, url, kw):
        if m == "POST":
            bodies.append(kw["json"])
            return Resp(202, headers={"Location": f"{REFRESHES}/rid-1"})
        return Resp(200, {"extendedStatus": "Completed"})

    r, _ = _refresher(handler)
    r.refresh(WS, DS, all_partitions=True)
    assert bodies == [refresh_mod.ENHANCED_ALL] and bodies[0]["applyRefreshPolicy"] is False


def test_refresh_failure_surfaces_service_error():
    def handler(m, url, kw):
        if m == "POST":
            return Resp(202, headers={"Location": f"{REFRESHES}/r1"})
        return Resp(200, {"status": "Failed", "serviceExceptionJson": "{\"errorCode\":\"DMTS_Credential\"}"})

    r, _ = _refresher(handler)
    with pytest.raises(RuntimeError, match="DMTS_Credential"):
        r.refresh(WS, DS)


def test_refresh_models_skips_when_unconfigured_and_validates():
    assert refresh_mod.refresh_models(None, settings()) == []
    with pytest.raises(ValueError, match="itemId"):
        refresh_mod.refresh_models(None, settings(semantic_models={"m": {"workspaceId": "w"}}))


# ---------------------------------------------------------------- settings / orchestration
def test_settings_from_env():
    s = Settings.from_env({"VALUELENS_MODULES": "core, m365Activity", "VALUELENS_AUDIT_HISTORY_DAYS": "90",
                           "VALUELENS_SEMANTIC_MODELS": json.dumps({"valueLensModel": {"workspaceId": "w", "itemId": "i"}}),
                           "VALUELENS_SQL_READER_CLIENT_ID": "c"})
    assert s.has("m365Activity") and not s.has("orgData") and s.audit_history_days == 90
    assert s.semantic_models["valueLensModel"]["itemId"] == "i" and s.sql_reader_client_id == "c"
    assert Settings.from_env({}).modules == frozenset({"core", "orgData"})
    with pytest.raises(ValueError):
        Settings.from_env({"VALUELENS_SEMANTIC_MODELS": "[1]"})
    with pytest.raises(ValueError):
        Settings.from_env({"VALUELENS_AUDIT_HISTORY_DAYS": "lots"})


def test_backfill_days_setting_from_env():
    assert Settings.from_env({"VALUELENS_AUDIT_BACKFILL_DAYS": "90"}).audit_backfill_days == 90
    assert Settings.from_env({}).audit_backfill_days == 0
    with pytest.raises(ValueError):
        Settings.from_env({"VALUELENS_AUDIT_BACKFILL_DAYS": "lots"})


def test_audit_backfill_reloads_older_days_despite_high_water_mark(tmp_path):
    store = LocalStore(tmp_path)
    store.write_json(audit_collect.STATE, {"high_water_mark": (NOW - timedelta(hours=2)).isoformat()})
    usual = audit_collect.AuditCollector(None, store, settings(audit_history_days=30, audit_lookback_days=1), now=NOW)
    assert usual.plan()[0][0] >= NOW - timedelta(days=2)
    backfill = audit_collect.AuditCollector(None, store, settings(audit_history_days=30, audit_lookback_days=1,
                                                                   audit_backfill_days=90), now=NOW)
    windows = backfill.plan()
    assert windows[0][0] <= NOW - timedelta(days=90) and windows[-1][1] == NOW
    # The reload never asks for less than the usual run would.
    short = audit_collect.AuditCollector(None, store, settings(audit_lookback_days=7, audit_backfill_days=1), now=NOW)
    assert short.plan()[0][0] <= NOW - timedelta(days=7)


def test_audit_reload_cut_off_carries_over_until_a_run_merges_it(tmp_path):
    # The installer sets VALUELENS_AUDIT_BACKFILL_DAYS on one run. A reload that run doesn't finish (the run job
    # stops at 4 h) carries over: the next runs, without the setting, plan it again, query only the windows it
    # didn't finish and keep them from `prune`. A clean merge ends it, and the run after plans as usual.
    hw = (NOW - timedelta(hours=2)).isoformat()
    records = [_record(i, NOW - timedelta(hours=95 - 8 * i)) for i in range(12)]  # one in each 8 h window
    store = LocalStore(tmp_path)
    store.write_json(audit_collect.STATE, {"high_water_mark": hw})

    class StopsAfterFourWindows(AuditGraph):
        def __call__(self, method, url, kw):
            if method == "POST" and len(self.created) >= 4:
                raise ReplicaStopped()
            return super().__call__(method, url, kw)

    api, _ = make_api(StopsAfterFourWindows(records))
    with pytest.raises(ReplicaStopped):
        audit_collect.collect_audit(api, store, settings(audit_lookback_days=1, audit_backfill_days=4), now=NOW,
                                    sleep=lambda x: None, max_concurrent=1)
    state = store.read_json(audit_collect.STATE)
    assert state["backfill_from"] == (NOW - timedelta(days=4)).isoformat() and state["high_water_mark"] == hw
    done = {k for k, w in state["windows"].items() if w["status"] == "succeeded"}
    assert len(done) == 4

    s = settings(audit_lookback_days=1)
    nightly = NOW + timedelta(days=1)
    rerun = AuditGraph(records)
    api, _ = make_api(rerun)
    assert audit_collect.collect_audit(api, store, s, now=nightly, sleep=lambda x: None)["rows"] == 12
    queried = {audit_collect.audit.stable_window_key(ws, we) for ws, we in rerun.created}
    assert len(queried) == 12 and not queried & done
    assert len(_parsed(store)[0]) == 12
    state = store.read_json(audit_collect.STATE)
    assert "backfill_from" not in state and done <= set(state["windows"])

    # Merged: the next run plans from the high-water mark and the look-back again, and prunes the reload's windows.
    later = nightly + timedelta(days=1)
    assert audit_collect.AuditCollector(None, store, s, now=later).plan()[0][0] == NOW - timedelta(hours=4)
    api, _ = make_api(AuditGraph(records))
    audit_collect.collect_audit(api, store, s, now=later, sleep=lambda x: None)
    windows = store.read_json(audit_collect.STATE)["windows"]
    assert not set(windows) & done
    assert min(datetime.fromisoformat(w["window_start"]) for w in windows.values()) == NOW - timedelta(hours=4)


def test_audit_reload_only_moves_its_start_earlier(tmp_path):
    store = LocalStore(tmp_path)

    def remember(days, now=NOW):
        audit_collect.AuditCollector(None, store, settings(audit_backfill_days=days), now=now).remember_backfill()
        return (store.read_json(audit_collect.STATE) or {}).get("backfill_from")

    assert remember(0) is None
    assert remember(30) == (NOW - timedelta(days=30)).isoformat()
    assert remember(90) == (NOW - timedelta(days=90)).isoformat()
    # A smaller reload while a bigger one is pending, or the same one a day later, leaves the start.
    assert remember(7) == remember(90, now=NOW + timedelta(days=1)) == (NOW - timedelta(days=90)).isoformat()
    # Without the setting, a run plans the pending reload from that start, on the same window grid.
    pending = audit_collect.AuditCollector(None, store, settings(), now=NOW + timedelta(days=2))
    assert pending.plan()[0][0] == NOW - timedelta(days=90, hours=4)


def test_audit_first_run_with_the_reload_setting_ends_the_reload(tmp_path):
    # The installer starts the first run with the setting too (the history it chose); it loads as before.
    store = LocalStore(tmp_path)
    records = [_record(i, NOW - timedelta(hours=40 - 8 * i)) for i in range(5)]
    api, _ = make_api(AuditGraph(records))
    assert audit_collect.collect_audit(api, store, settings(audit_history_days=2, audit_backfill_days=2), now=NOW,
                                       sleep=lambda x: None)["rows"] == 5
    state = store.read_json(audit_collect.STATE)
    assert "backfill_from" not in state and state["high_water_mark"] == (NOW - timedelta(hours=8)).isoformat()
    later = audit_collect.AuditCollector(None, store, settings(audit_lookback_days=1), now=NOW + timedelta(days=1))
    assert later.plan()[0][0] == NOW - timedelta(hours=12)


def test_audit_reload_is_kept_after_a_failed_window_or_merge(tmp_path, monkeypatch):
    # Only a run that merges every window ends a reload. After a failed window or a failed merge, the next run
    # plans it again without the setting.
    hw = (NOW - timedelta(hours=2)).isoformat()
    since = (NOW - timedelta(days=3)).isoformat()
    first = NOW - timedelta(days=3, hours=4)  # the reload's first window, 2026-09-07 08:00
    records = [_record(i, NOW - timedelta(hours=60 - 6 * i)) for i in range(10)]  # across 3 days

    def seeded(name):
        store = LocalStore(tmp_path / name)
        store.write_json(audit_collect.STATE, {"high_water_mark": hw})
        return store

    def collect(store, graph_fake, days=3, **kw):
        api, _ = make_api(graph_fake)
        return audit_collect.collect_audit(api, store, settings(audit_backfill_days=days), now=NOW,
                                           sleep=lambda x: None, merge_pass_records=1, **kw)

    store = seeded("window")
    failing = AuditGraph(records, status=lambda ws, we, n: "failed" if ws == first else "succeeded")
    with pytest.raises(RuntimeError, match=r"1 audit window\(s\) failed"):
        collect(store, failing, window_retries=0, min_chunk_hours=8)
    assert store.read_json(audit_collect.STATE)["backfill_from"] == since
    rerun = AuditGraph(records)
    assert collect(store, rerun, days=0)["rows"] == 10
    assert rerun.created == [(first, first + timedelta(hours=8))]
    assert "backfill_from" not in store.read_json(audit_collect.STATE)

    real, passes = audit_collect.AuditCollector._merge_pass, []

    def out_of_memory_in_the_second_pass(self, files, spill):
        passes.append(files)
        if len(passes) == 2:
            raise duckdb.OutOfMemoryException("Out of Memory Error: could not allocate block")
        return real(self, files, spill)

    store = seeded("merge")
    monkeypatch.setattr(audit_collect.AuditCollector, "_merge_pass", out_of_memory_in_the_second_pass)
    with pytest.raises(duckdb.OutOfMemoryException):
        collect(store, AuditGraph(records))
    assert len(passes) == 2 and store.read_json(audit_collect.STATE)["backfill_from"] == since
    monkeypatch.undo()
    rerun = AuditGraph(records)
    assert collect(store, rerun, days=0) == {"rows": 10, "days": 3}
    assert rerun.created == [] and "backfill_from" not in store.read_json(audit_collect.STATE)


def test_audit_logs_how_long_each_window_took_and_a_fetch_summary(tmp_path, caplog):
    # The live run sizes a reload from these lines: each window's wait for a query slot, its query (with its
    # polls) and its drain, then the fetch's wall time and its median and p90 query times.
    clock = [0.0]
    start = NOW - timedelta(days=1, hours=4)  # the plan's first window, 2026-09-09 08:00
    records = [_record(i, start + timedelta(hours=h)) for i, h in enumerate((1, 2, 9, 25))]
    running = [0, 1, 2, 4]  # polls that find each window's query still running

    class TimedGraph(AuditGraph):
        """Scripts each query's statuses; a records page takes half a second on the clock."""

        def __init__(self, recs):
            super().__init__(recs)
            self.script, self.polls = {}, {}

        def __call__(self, method, url, kw):
            resp = super().__call__(method, url, kw)
            if method == "POST":
                ws, we = self.created[-1]
                index, attempt = (ws - start) // timedelta(hours=8), self.created.count((ws, we))
                self.script[resp.json()["id"]] = (["running", "failed"] if (index, attempt) == (1, 1)
                                                  else ["running"] * running[index] + ["succeeded"])
            elif "/records" in url:
                clock[0] += 0.5
            else:
                qid = url.rsplit("/", 1)[-1]
                n = self.polls[qid] = self.polls.get(qid, 0) + 1
                script = self.script[qid]
                return Resp(200, {"status": script[min(n, len(script)) - 1]})
            return resp

    keys = [audit_collect.audit.stable_window_key(start + timedelta(hours=8 * i),
                                                  min(start + timedelta(hours=8 * (i + 1)), NOW)) for i in range(4)]
    store = LocalStore(tmp_path)
    api, _ = make_api(TimedGraph(records))
    with caplog.at_level("INFO", logger="valuelens_jobs.collect.audit"):
        assert audit_collect.collect_audit(api, store, settings(), now=NOW, max_concurrent=1, retry_base_seconds=0,
                                           sleep=lambda s: clock.__setitem__(0, clock[0] + s),
                                           clock=lambda: clock[0])["rows"] == 4
    lines = [r.getMessage() for r in caplog.records]
    for key, done in zip(keys, ("+2 record(s) in 2 page(s); slot wait 0.0s, ready 0.0s (1 poll(s)), drain 1.0s",
                                "+1 record(s) in 1 page(s); slot wait 0.0s, ready 30.0s (2 poll(s)), drain 0.5s",
                                "+0 record(s) in 0 page(s); slot wait 0.0s, ready 60.0s (3 poll(s)), drain 0.5s",
                                "+1 record(s) in 1 page(s); slot wait 0.0s, ready 120.0s (5 poll(s)), drain 0.5s")):
        assert f"audit: window {key} {done}" in lines
    assert any(line.startswith(f"audit: window {keys[1]} attempt 1 failed after 30.0s: AuditQueryFailed: Query ")
               and line.endswith(" ended with status: failed; new query in 0s (retry 1/3)") for line in lines)
    assert ("audit: fetch took 242.5s for 4 window(s), 1 failed attempt(s); ready median 45.0s, p90 120.0s, "
            "max 120.0s; drain median 0.50s a page over 4 page(s)") in lines
    window = store.read_json(audit_collect.STATE)["windows"][keys[1]]
    assert window["attempts"] == 2
    assert window["timing"] == {"slot_wait_s": 0.0, "ready_s": 30.0, "polls": 2, "drain_s": 0.5}


def test_audit_window_timing_keeps_the_wait_for_a_query_slot_apart(tmp_path):
    # With every query slot in use, a window waits before its query is created; that wait isn't the query's.
    clock = [0.0]

    class BusyLimiter:
        def __enter__(self):
            clock[0] += 7.0
            return self

        def __exit__(self, *exc):
            return False

    api, _ = make_api(AuditGraph([_record(0, NOW - timedelta(hours=3))]))
    collector = audit_collect.AuditCollector(api, LocalStore(tmp_path), settings(), now=NOW,
                                             sleep=lambda s: None, clock=lambda: clock[0])
    collector.limiter = BusyLimiter()
    assert collector._window(NOW - timedelta(hours=4), NOW)[1:] == (
        1, {"slot_wait_s": 7.0, "ready_s": 0.0, "polls": 1, "drain_s": 0.0, "pages": 1})


def test_publish_targets_follow_modules():
    assert jobs_main.publish_targets(settings(modules=frozenset({"core"}))) == ["curated", "licensed"]
    assert jobs_main.publish_targets(settings()) == ["curated", "licensed", "org", "m365"]
    assert jobs_main.publish_targets(settings(sample_data=True)) == ["curated", "licensed", "org"]


def test_sample_data_setting_from_env():
    assert Settings.from_env({"VALUELENS_SAMPLE_DATA": "true"}).sample_data is True
    assert Settings.from_env({}).sample_data is False


def test_sample_week_shift_keeps_weekdays_and_lands_last_week():
    from valuelens_jobs.sample import week_shift

    assert week_shift(date(2026, 8, 31), date(2026, 10, 6)) == 35
    assert week_shift(date(2026, 10, 5), date(2026, 10, 6)) == 0
    assert week_shift(date(2026, 10, 6), date(2026, 10, 6)) == 0


def test_sample_load_runs_through_processor(tmp_path):
    from pathlib import Path

    from valuelens_jobs import sample

    folder = Path(__file__).resolve().parents[1] / "samples"
    store = LocalStore(tmp_path)
    info = sample.load(store, folder=folder, today=date(2026, 10, 6))
    assert info["people"] == 170 and info["shift_days"] == 35
    # The sample includes 482 Copilot Studio test-pane and 9 autonomous-run rows, which the processor drops.
    assert jobs_main.process(store) == info["interactions"] - 491

    curated = f"read_parquet('{(tmp_path / 'curated/copilot_interactions_curated').as_posix()}/*.parquet')"
    users, latest, licensed = duckdb.sql(
        f"SELECT count(DISTINCT Audit_UserId), max(InteractionDate), "
        f"count(*) FILTER (WHERE \"Has license\"::VARCHAR = 'TRUE') FROM {curated}").fetchone()
    assert users == 151 and latest == date(2026, 10, 5) and licensed > 0
    for prefix in ("raw/copilot_org_data", "raw/copilot_licensed_users"):
        rows = duckdb.sql(f"SELECT count(*) FROM read_parquet('{(tmp_path / prefix).as_posix()}/*.parquet')").fetchone()[0]
        assert rows == 170


def test_collect_dispatch_follows_modules(tmp_path, monkeypatch):
    called = []
    for name in ("collect_licensed", "collect_org", "collect_m365"):
        monkeypatch.setattr(graph, name, lambda *a, _n=name, **k: called.append(_n))
    monkeypatch.setattr(audit_collect, "collect_audit", lambda *a, **k: called.append("collect_audit"))
    jobs_main.collect(LocalStore(tmp_path), settings(modules=frozenset({"core"})), api=object())
    assert called == ["collect_licensed", "collect_audit"]


def test_sql_connect_retries_while_serverless_db_resumes(monkeypatch):
    class Error(Exception):
        pass

    outcomes = [Error("HYT00", "[HYT00] Login timeout expired (0) (SQLDriverConnect)"),
                Error("42000", "[42000] Database 'valuelens' is not currently available. (40613)"), "conn"]

    def fake_connect(*a, **k):
        item = outcomes.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setitem(sys.modules, "pyodbc", SimpleNamespace(Error=Error, connect=fake_connect))
    s = SimpleNamespace(sql_server="srv", sql_database="db")
    tokens = SimpleNamespace(get=lambda scope: "tok")
    waits = []
    assert sql_mod.connect(s, tokens, sleep=waits.append) == "conn"
    assert waits == [10, 20]

    outcomes[:] = [Error("28000", "Login failed for user")]
    with pytest.raises(Error, match="28000"):
        sql_mod.connect(s, tokens, sleep=waits.append)


def test_collect_keeps_going_when_a_source_fails(tmp_path, monkeypatch):
    called = []
    for name in ("collect_licensed", "collect_org", "collect_m365"):
        monkeypatch.setattr(graph, name, lambda *a, _n=name, **k: called.append(_n))

    def boom(*a, **k):
        raise RuntimeError("3 audit window(s) failed")

    monkeypatch.setattr(audit_collect, "collect_audit", boom)
    out = jobs_main.collect(LocalStore(tmp_path), settings(), api=object())
    assert called == ["collect_licensed", "collect_org", "collect_m365"]
    assert out["errors"] == {"audit": "RuntimeError: 3 audit window(s) failed"}


def test_run_publishes_then_fails_when_a_source_failed(monkeypatch):
    ran = []
    monkeypatch.setattr(jobs_main, "open_store", lambda *a: object())
    monkeypatch.setattr(jobs_main, "collect", lambda *a: ran.append("collect") or {"errors": {"audit": "boom"}})
    monkeypatch.setattr(jobs_main, "process", lambda *a, **k: ran.append("process"))
    monkeypatch.setattr(jobs_main, "publish_step", lambda *a: ran.append("publish") or [{"oldest_day": "2020-01-01"}])
    monkeypatch.setattr(jobs_main, "refresh_step", lambda *a, **kw: ran.append(("refresh", kw)))
    monkeypatch.setattr(jobs_main.Settings, "from_env", classmethod(lambda cls, env=None: settings()))
    with pytest.raises(RuntimeError, match="audit: boom"):
        jobs_main.main(["run"])
    assert ran == ["collect", "process", "publish", ("refresh", {"publish_results": [{"oldest_day": "2020-01-01"}]})]


def test_full_local_pipeline_collect_to_publish(tmp_path, monkeypatch):
    """Audit + licensed from fake Graph -> curate -> publish into sqlite."""
    records = [_record(1, NOW - timedelta(hours=5)), _record(2, NOW - timedelta(hours=4))]
    fake = AuditGraph(records)

    def handler(m, url, kw):
        if "getOffice365ActiveUserDetail" in url:
            return Resp(200, text=LICENSED_CSV, content=LICENSED_CSV.encode())
        if url == graph.COPILOT_USAGE_URL:
            return Resp(200, text=COPILOT_CSV, content=COPILOT_CSV.encode())
        return fake(m, url, kw)

    api, _ = make_api(handler)
    store = LocalStore(tmp_path)
    s = settings(modules=frozenset({"core"}))
    monkeypatch.setattr(audit_collect, "collect_audit",
                        lambda a, st, se: audit_collect.AuditCollector(a, st, se, now=NOW, sleep=lambda x: None).run())
    jobs_main.collect(store, s, api=api)
    assert jobs_main.process(store) == 2
    conn = sqlite3.connect(":memory:")
    results = pub.publish(conn, store, jobs_main.publish_targets(s))
    assert results[0]["rows"] == 2
    assert conn.execute("SELECT count(*) FROM copilot_licensed_users").fetchone() == (2,)


def test_adls_store_skips_hns_directory_markers(tmp_path):
    from valuelens_jobs.storage import AdlsStore

    deleted = []

    class Container:
        def list_blobs(self, name_starts_with, include=None):
            assert include == ["metadata"]
            return [
                SimpleNamespace(name="copilot_licensed_users", metadata={"hdi_isfolder": "true"}),
                SimpleNamespace(name="copilot_licensed_users/part-0.parquet", metadata={}),
                SimpleNamespace(name="copilot_licensed_users/part-1.parquet", metadata=None),
                SimpleNamespace(name="copilot_licensed_users_old/part-0.parquet", metadata={}),
            ]

        def delete_blob(self, name):
            deleted.append(name)

    service = SimpleNamespace(get_container_client=lambda name: Container())
    store = AdlsStore("acct", root=tmp_path, service=service)
    assert store.list("raw/copilot_licensed_users") == [
        "raw/copilot_licensed_users/part-0.parquet", "raw/copilot_licensed_users/part-1.parquet"]
    store.remove([r for r in store.list("raw/copilot_licensed_users") if not r.endswith("part-0.parquet")])
    assert deleted == ["copilot_licensed_users/part-1.parquet"]


def test_adls_store_evict_frees_the_local_copy_and_keeps_the_blobs(tmp_path):
    from valuelens_jobs.storage import AdlsStore

    blobs, deleted = {"_audit_staging/win_k_0000.jsonl.gz": b"page"}, []

    class Container:
        def list_blobs(self, name_starts_with, include=None):
            return [SimpleNamespace(name=n, metadata={}) for n in sorted(blobs) if n.startswith(name_starts_with)]

        def download_blob(self, name):
            return SimpleNamespace(readinto=lambda fh: fh.write(blobs[name]))

        def delete_blob(self, name):
            deleted.append(name)

    service = SimpleNamespace(get_container_client=lambda name: Container())
    store = AdlsStore("acct", root=tmp_path / "adls", service=service)
    staged = ["raw/_audit_staging/win_k_0000.jsonl.gz"]
    assert store.pull("raw/_audit_staging") == staged and store.path(staged[0]).read_bytes() == b"page"
    store.evict("raw/_audit_staging")
    assert not (tmp_path / "adls" / "raw" / "_audit_staging").exists()
    assert store.list("raw/_audit_staging") == staged and deleted == []
    store.evict("raw/_audit_staging")
    assert store.pull("raw/_audit_staging") == staged and store.path(staged[0]).is_file()

    # In a local store the folder is the data itself, so nothing is removed.
    local = LocalStore(tmp_path / "local")
    local.write_json("raw/_audit_staging/page.json", {})
    local.evict("raw/_audit_staging")
    assert local.list("raw/_audit_staging") == ["raw/_audit_staging/page.json"]