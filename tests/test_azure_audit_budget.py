"""The Azure run job's time budget: a run that runs out of time publishes what it has loaded, newest weeks first,
and the next run carries on.

Graph and Power BI are faked at the HTTP-session level, as in test_azure_jobs, and `Clock` stands in for
time.monotonic and time.sleep, so a run's four hours pass at once. Azure SQL is sqlite3.
"""
from __future__ import annotations

import gzip
import importlib
import logging
import sqlite3
from datetime import datetime, timedelta, timezone

import duckdb
import pytest

from test_access_scope import CSV, _access_tables
from test_azure_jobs import NOW, WS, AuditGraph, Resp, Session, Tokens, _parsed, _record, make_api, settings
from test_incremental_processing import _curated
from valuelens_core import audit as core_audit
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import access as jobs_access
from valuelens_jobs import api as api_mod
from valuelens_jobs import refresh as refresh_mod
from valuelens_jobs.collect import audit as audit_collect
from valuelens_jobs.collect import graph
from valuelens_jobs.storage import LocalStore
from valuelens_jobs.tables import write_rows

UTC = timezone.utc
REAL_COLLECT_AUDIT = audit_collect.collect_audit
# The windows of a one-day history (settings(): history 1, lookback 0) in 8-hour chunks, oldest first.
W1 = (datetime(2026, 9, 9, 8, tzinfo=UTC), datetime(2026, 9, 9, 16, tzinfo=UTC))
W2 = (datetime(2026, 9, 9, 16, tzinfo=UTC), datetime(2026, 9, 10, 0, tzinfo=UTC))
W3 = (datetime(2026, 9, 10, 0, tzinfo=UTC), datetime(2026, 9, 10, 8, tzinfo=UTC))
W4 = (datetime(2026, 9, 10, 8, tzinfo=UTC), NOW)
# One record in each.
RECORDS = [_record(i, when) for i, when in enumerate(
    [datetime(2026, 9, 9, 10, tzinfo=UTC), datetime(2026, 9, 9, 20, tzinfo=UTC),
     datetime(2026, 9, 10, 3, tzinfo=UTC), datetime(2026, 9, 10, 9, tzinfo=UTC)], 1)]
ENV = {"VALUELENS_MODULES": "core", "VALUELENS_AUDIT_HISTORY_DAYS": "1", "VALUELENS_AUDIT_LOOKBACK_DAYS": "0"}
CURATED = jobs_main.CURATED_PREFIX


# ---------------------------------------------------------------- fakes
class Clock:
    """time.monotonic and time.sleep in one: sleeping moves the clock on."""

    def __init__(self, t=0.0):
        self.t, self.slept = float(t), []

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.t += seconds

    def advance(self, seconds):
        self.t += seconds


class SlowGraph(AuditGraph):
    """AuditGraph whose queries can hang (`hang(ws, we)` keeps them running) and whose calls take time.

    `reply(query_id, window)` can answer a status poll instead (a Resp, or None for the usual answer).
    """

    def __init__(self, records, clock, hang=None, post_s=0, page_s=0, reply=None, **kw):
        super().__init__(records, **kw)
        self.clock, self.hang, self.post_s, self.page_s, self.reply = clock, hang, post_s, page_s, reply
        self.window_of, self.polls, self.pages = {}, [], []

    def __call__(self, method, url, kw):
        base = audit_collect.QUERIES
        if method == "POST" and url == base:
            self.clock.advance(self.post_s)
            r = super().__call__(method, url, kw)
            if r.status_code == 201:
                self.window_of[r.json()["id"]] = self.created[-1]
            return r
        qid = url[len(base) + 1:].split("/")[0].split("?")[0]
        window = self.window_of.get(qid)
        if "/records" not in url:
            self.polls.append(qid)
            answer = self.reply(qid, window) if self.reply is not None else None
            if answer is not None:
                return answer
            if self.hang is not None and window is not None and self.hang(*window):
                return Resp(200, {"status": "running"})
            return super().__call__(method, url, kw)
        self.clock.advance(self.page_s)
        self.pages.append(qid)
        return super().__call__(method, url, kw)

    def qid(self, window):
        return next(q for q, w in self.window_of.items() if w == window)


class KeepOpen:
    """A sqlite connection that publish_step can close and the test can still read."""

    def __init__(self, conn, on_close=None):
        self._conn, self._on_close = conn, on_close

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        if self._on_close is not None:
            self._on_close()


def clocked_api(handler, clock):
    return api_mod.Api(Tokens(), session=Session(handler), sleep=clock.sleep, clock=clock)


def collector(api, store, clock, s=None, now=NOW, **kw):
    return audit_collect.AuditCollector(api, store, s or settings(), now=now, sleep=clock.sleep, clock=clock,
                                        max_concurrent=1, **kw)


def key(window):
    return core_audit.stable_window_key(*window)


def _state(store):
    return store.read_json(audit_collect.STATE, {}) or {}


def _seen(state):
    """Where the audit load has got to, as the job records it for `status` (see __main__._audit_seen)."""
    return {k: state[k] for k in audit_collect.SEEN if state.get(k) is not None}


def _position(record):
    """A `processed` or `published` record without its timestamps."""
    return {k: v for k, v in record.items() if k not in ("process_started_at", "published_at")}


def _patch_audit(monkeypatch, clock, seen=None, **extra):
    """The job's audit collector, at NOW, one query at a time, sleeping on `clock`. `seen` gets each run's kwargs."""
    def collect_audit(api, store, s, **kw):
        if seen is not None:
            seen.append(kw)
        return REAL_COLLECT_AUDIT(api, store, s, now=NOW, sleep=clock.sleep, max_concurrent=1, **extra, **kw)

    monkeypatch.setattr(audit_collect, "collect_audit", collect_audit)


def _wire(monkeypatch, store, api, clock, seen=None, **extra):
    """main() over `store` and `api`, with the licensed-users collector a no-op."""
    monkeypatch.setattr(jobs_main, "_api", lambda s: api)
    monkeypatch.setattr(jobs_main, "open_store", lambda data_dir, s: store)
    monkeypatch.setattr(graph, "collect_licensed", lambda *a, **k: None)
    _patch_audit(monkeypatch, clock, seen, **extra)


# ---------------------------------------------------------------- the audit fetch's budget
def test_the_budget_pauses_the_waiting_window_and_merges_the_finished_ones(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    clock, store = Clock(), LocalStore(tmp_path)
    g = SlowGraph(RECORDS, clock, hang=lambda ws, we: (ws, we) == W2)
    api = clocked_api(g, clock)
    out = collector(api, store, clock, deadline=300, hard_deadline=14_400).run()

    # Newest first; W2's query was still running at the budget, so W1 never started.
    assert g.created == [W4, W3, W2]
    assert clock.slept == [30] * 9 and clock() == 270
    assert out == {"rows": 2, "days": 1, "paused": True, "windows_left": 2,
                   "loaded_back_to": "2026-09-10T00:00:00+00:00"}
    st = _state(store)
    w2 = st["windows"][key(W2)]
    assert w2["status"] == "paused" and w2["query_id"] == g.qid(W2)
    assert w2["query_created_at"] == NOW.isoformat()
    assert key(W1) not in st["windows"]
    assert all(st["windows"][key(w)]["merged_at"] for w in (W3, W4))
    # The high-water mark holds until every window has merged.
    assert not st.get("high_water_mark")
    assert st["pending_high_water_mark"].startswith("2026-09-10T09:00")
    assert st["rebuild_when_loaded"] is True
    assert st["loaded_back_to"] == "2026-09-10T00:00:00+00:00" and st["windows_left"] == 2
    assert st["paused_at"] == (NOW + timedelta(seconds=270)).isoformat()
    assert st["merge_open"]["clock"] == 270 and st["merge_open"]["cutoff_s"] == 14_130.0
    assert api.deadline is None and api.on_throttle is None
    assert {audit_collect._window_key(rel) for rel in store.list(audit_collect.STAGING)} == {key(W3), key(W4)}
    assert "History loaded back to 2026-09-10. The next run carries on (2 windows left)." in caplog.text


def test_the_budget_counts_from_the_jobs_start(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    clock, seen = Clock(), []
    g = SlowGraph(RECORDS, clock, hang=lambda ws, we: True)
    _patch_audit(monkeypatch, clock, seen)
    for name, took in (("licensed", 120), ("org", 60), ("m365", 60)):
        monkeypatch.setattr(graph, f"collect_{name}", lambda *a, _took=took, **k: clock.advance(_took))
    budget = jobs_main.run_budget(None, {"VALUELENS_AUDIT_TIME_BUDGET_MIN": "5"}, start=0, clock=clock)
    out = jobs_main.collect(LocalStore(tmp_path / "a"), settings(), clocked_api(g, clock), budget=budget)

    # The other collectors took 4 of the 5 minutes, so audit had 1.
    assert seen == [{"deadline": 300.0, "hard_deadline": 14_400.0, "clock": clock}]
    assert clock.slept == [30]
    assert out["audit"] == {"rows": 0, "days": 0, "paused": True, "windows_left": 4, "loaded_back_to": None}
    assert "collect licensed: took 2.0 min" in caplog.text
    assert ("collect audit: fetching for up to 1 min, until 5 min after the job's start "
            "(VALUELENS_AUDIT_TIME_BUDGET_MIN=5); the run's limit is 240 min") in caplog.text

    # Past the budget before audit starts: no window starts, and nothing fails.
    clock2 = Clock()
    g2 = SlowGraph(RECORDS, clock2)
    _patch_audit(monkeypatch, clock2)
    monkeypatch.setattr(graph, "collect_licensed", lambda *a, **k: clock2.advance(400))
    for name in ("org", "m365"):
        monkeypatch.setattr(graph, f"collect_{name}", lambda *a, **k: None)
    budget = jobs_main.run_budget(None, {"VALUELENS_AUDIT_TIME_BUDGET_MIN": "5"}, start=0, clock=clock2)
    out = jobs_main.collect(LocalStore(tmp_path / "b"), settings(), clocked_api(g2, clock2), budget=budget)
    assert g2.created == [] and "errors" not in out
    assert out["audit"]["windows_left"] == 4


def test_the_reserve_grows_with_the_last_merge_to_publish_time(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    clock = Clock(50)
    b = jobs_main.run_budget(None, {}, start=50, clock=clock)
    assert (b.fetch_deadline, b.hard_deadline, b.refresh_deadline, b.reserve_s) == (10_850, 14_450, 13_850, 3_600)

    store = LocalStore(tmp_path)
    store.write_json(audit_collect.STATE, {"last_merge_to_publish_s": 3_000})
    b = jobs_main.run_budget(store, {}, start=0, clock=Clock())
    assert (b.reserve_s, b.fetch_deadline) == (4_500, 9_900)

    # A run stopped between its merge and its publish had at least `cutoff_s` left: the reserve covers it.
    store.write_json(audit_collect.STATE, {"last_merge_to_publish_s": 3_000, "merge_open": {
        "started_at": "2026-09-10T03:00:00+00:00", "clock": 9_400.0, "cutoff_s": 5_000.0}})
    b = jobs_main.run_budget(store, {}, start=0, clock=Clock())
    assert (b.reserve_s, b.fetch_deadline) == (7_500, 6_900)
    assert "merge_open" in _state(store)
    b = jobs_main.run_budget(store, {}, start=0, clock=Clock(), settle=True)
    assert b.reserve_s == 7_500
    st = _state(store)
    assert "merge_open" not in st and st["last_merge_to_publish_s"] == 5_000.0
    assert "stopped before it published" in caplog.text and "keeps at least 125 min back" in caplog.text

    assert jobs_main.run_budget(None, {"VALUELENS_JOB_TIMEOUT_SEC": "7200"}, start=0, clock=Clock()).fetch_deadline \
        == 3_600

    # The run records its own merge-to-publish time; a reading from before the job started isn't one.
    clock = Clock(1_000)
    budget = jobs_main.RunBudget(clock, 0.0, 14_400.0, 3_600.0, 10_800.0)
    store.write_json(audit_collect.STATE, {"merge_open": {"clock": 400.0, "cutoff_s": 14_000.0}})
    jobs_main._record_merge_to_publish(store, budget)
    assert _state(store) == {"last_merge_to_publish_s": 600.0}
    store.write_json(audit_collect.STATE, {"merge_open": {"clock": -5.0, "cutoff_s": 14_000.0}})
    jobs_main._record_merge_to_publish(store, budget)
    assert _state(store) == {}


def test_a_page_past_the_budget_pauses_the_window_and_leaves_no_pages(tmp_path):
    clock, store = Clock(), LocalStore(tmp_path)
    records = [_record(31, datetime(2026, 9, 10, 3, tzinfo=UTC)), _record(32, datetime(2026, 9, 10, 5, tzinfo=UTC)),
               RECORDS[3]]
    g = SlowGraph(records, clock, page_s=100)
    out = collector(clocked_api(g, clock), store, clock, deadline=200, hard_deadline=14_400).run()

    w3 = _state(store)["windows"][key(W3)]
    assert w3["status"] == "paused" and w3["query_id"] == g.qid(W3) and w3["files"] == []
    assert key(W3) not in {audit_collect._window_key(rel) for rel in store.list(audit_collect.STAGING)}
    assert out["windows_left"] == 3 and out["loaded_back_to"] == "2026-09-10T08:00:00+00:00"

    # The next run drains the paused query again from its first page, without a new query.
    later = NOW + timedelta(hours=1)
    collector(clocked_api(g, clock), store, clock, now=later).run()
    w3 = _state(store)["windows"][key(W3)]
    assert w3["status"] == "succeeded" and w3["rows"] == 2 and w3["timing"]["resumed"] is True
    assert g.created.count(W3) == 1
    assert (W4[0], later) in g.created
    assert len(_parsed(store)[0]) == 3


def test_a_retry_wait_past_the_budget_pauses_without_sleeping_or_splitting(tmp_path):
    clock, store = Clock(), LocalStore(tmp_path)
    g = SlowGraph(RECORDS, clock, status=lambda ws, we, n: "failed" if (ws, we) == W3 and n == 1 else "succeeded")
    out = collector(clocked_api(g, clock), store, clock, deadline=20, hard_deadline=14_400).run()
    w3 = _state(store)["windows"][key(W3)]
    assert w3["status"] == "paused" and w3["query_id"] is None
    assert clock.slept == [] and g.created == [W4, W3]
    assert out["paused"] and out["windows_left"] == 3


def test_a_throttled_request_stops_waiting_at_the_deadline(tmp_path):
    throttled = Resp(429, {}, headers={"Retry-After": "120"})
    clock, throttles = Clock(), []
    session = Session(lambda m, u, kw: throttled)
    api = api_mod.Api(Tokens(), session=session, sleep=clock.sleep, clock=clock, deadline=300,
                      on_throttle=lambda: throttles.append(clock()))
    with pytest.raises(api_mod.DeadlineReached):
        api.get("https://graph.microsoft.com/v1.0/x")
    assert clock.slept == [120, 120] and len(session.calls) == 3 and len(throttles) == 3

    clock = Clock()
    api = api_mod.Api(Tokens(), session=Session(lambda m, u, kw: throttled), sleep=clock.sleep, clock=clock,
                      deadline=100)
    with pytest.raises(api_mod.DeadlineReached):
        api.get("https://graph.microsoft.com/v1.0/x")
    assert clock.slept == []

    def down(m, u, kw):
        raise ConnectionError("network down")

    clock = Clock()
    api = api_mod.Api(Tokens(), session=Session(down), sleep=clock.sleep, clock=clock, deadline=5)
    with pytest.raises(api_mod.DeadlineReached):
        api.get("https://graph.microsoft.com/v1.0/x")
    assert clock.slept == [2]

    # In the collector, a poll throttled past the budget pauses the window with its query.
    clock, store = Clock(), LocalStore(tmp_path)
    g = SlowGraph(RECORDS, clock, reply=lambda qid, window: throttled if window == W4 else None)
    out = collector(clocked_api(g, clock), store, clock, deadline=300, hard_deadline=14_400).run()
    w4 = _state(store)["windows"][key(W4)]
    assert w4["status"] == "paused" and w4["query_id"] == g.qid(W4)
    assert clock.slept == [120, 120] and out["windows_left"] == 4


def test_a_budget_stop_does_not_split_the_window(tmp_path):
    w3a = (W3[0], datetime(2026, 9, 10, 4, tzinfo=UTC))
    w3b = (datetime(2026, 9, 10, 4, tzinfo=UTC), W3[1])
    # A query timeout splits the window.
    clock = Clock()
    g = SlowGraph(RECORDS, clock, hang=lambda ws, we: (ws, we) == W3)
    collector(clocked_api(g, clock), LocalStore(tmp_path / "timeout"), clock, max_wait_minutes=1).run()
    assert g.created == [W4, W3, w3b, w3a, W2, W1]

    # The budget ending first pauses it whole.
    clock, store = Clock(), LocalStore(tmp_path / "budget")
    g = SlowGraph(RECORDS, clock, hang=lambda ws, we: (ws, we) == W3)
    collector(clocked_api(g, clock), store, clock, max_wait_minutes=1, deadline=50, hard_deadline=14_400).run()
    assert g.created == [W4, W3]
    assert _state(store)["windows"][key(W3)]["status"] == "paused"


# ---------------------------------------------------------------- the run job
COLLECTORS = {
    "workday": ("workday", "collect_workday"),
    "defender": ("defender", "collect_defender"),
    "studio": ("studio", "collect_studio"),
    "viva": ("viva", "collect_viva"),
    "azure_ai": ("azure_ai", "collect_azure_ai"),
    "agent365": ("agent365", "collect_agent365"),
    "product_feedback": ("product_feedback", "collect_product_feedback"),
    "resource_graph": ("resource_graph", "collect_resource_graph"),
    "agent_evaluator": ("agent_evaluator", "collect_agent_evaluator"),
}


def test_audit_runs_after_every_other_collector(tmp_path, monkeypatch):
    ran = []

    def fake(name):
        return lambda *a, **k: ran.append(name)

    for name, (module, fn) in COLLECTORS.items():
        monkeypatch.setattr(importlib.import_module(f"valuelens_jobs.collect.{module}"), fn, fake(name))
    monkeypatch.setattr(importlib.import_module("valuelens_jobs.collect.agent_evaluator"), "remember_backfill",
                        lambda *a, **k: None)
    for name in ("licensed", "org", "m365"):
        monkeypatch.setattr(graph, f"collect_{name}", fake(name))
    monkeypatch.setattr(audit_collect, "collect_audit", fake("audit"))
    monkeypatch.setattr(audit_collect, "remember_backfill", lambda *a, **k: None)
    modules = frozenset({"core", "orgData", "workday", "m365Activity", "defender", "consumption", "agent365",
                         "productFeedback", "resourceGraph", "agentEvaluator"})
    s = settings(modules=modules, azure_ai_subscription="sub", dataverse_environments=("env",))
    out = jobs_main.collect(LocalStore(tmp_path), s, api=object())
    assert ran == ["licensed", "org", "workday", "m365", "defender", "studio", "viva", "azure_ai", "agent365",
                   "product_feedback", "resource_graph", "agent_evaluator", "audit"]
    assert "errors" not in out


def test_a_paused_run_processes_publishes_and_refreshes_and_exits_0(tmp_path, monkeypatch):
    clock, store = Clock(), LocalStore(tmp_path)
    g = SlowGraph(RECORDS, clock, hang=lambda ws, we: (ws, we) == W2)
    _wire(monkeypatch, store, clocked_api(g, clock), clock)
    ran, refreshed = [], {}

    def publish(st, s, conn=None):
        ran.append("publish")
        clock.advance(100)
        return []

    def refresh(s, **kw):
        ran.append("refresh")
        refreshed.update(kw)

    monkeypatch.setattr(jobs_main, "process", lambda st, **kw: ran.append("process"))
    monkeypatch.setattr(jobs_main, "publish_step", publish)
    monkeypatch.setattr(jobs_main, "refresh_step", refresh)
    assert jobs_main.main(["run"], env=dict(ENV, VALUELENS_AUDIT_TIME_BUDGET_MIN="5"), clock=clock) == 0
    assert ran == ["process", "publish", "refresh"]
    # VALUELENS_JOB_TIMEOUT_SEC isn't set: 14,400 seconds, and the refresh stops waiting 10 minutes before.
    assert refreshed["deadline"] == 13_800.0 and refreshed["store"] is store and refreshed["clock"] is clock
    st = _state(store)
    assert st["windows"][key(W2)]["status"] == "paused" and st["windows_left"] == 2
    assert st["last_merge_to_publish_s"] == 100.0 and "merge_open" not in st
    # The newest weeks it merged are in the reports: `status` reads how far back from the record of its publish.
    assert _position(st["published"]) == _seen(st) and set(_seen(st)) == {"pending_high_water_mark", "loaded_back_to"}

    # The installer's own access,refresh run stays incremental: it doesn't carry an owed full refresh.
    ran.clear()
    refreshed.clear()
    monkeypatch.setattr(jobs_main, "access_step", lambda st, s, conn=None: ran.append("access"))
    assert jobs_main.main(["run", "--steps", "access,refresh"], env=ENV, clock=clock) == 0
    assert ran == ["access", "refresh"] and "store" not in refreshed
    assert _state(store)["published"] == st["published"]


def test_a_failed_window_still_fails_the_run_after_it_publishes(tmp_path, monkeypatch):
    clock, store = Clock(), LocalStore(tmp_path)
    bad = Resp(400, {"error": {"code": "BadRequest", "message": "bad filter"}})
    g = SlowGraph(RECORDS, clock, reply=lambda qid, window: bad if window == W3 else None)
    _wire(monkeypatch, store, clocked_api(g, clock), clock)
    ran = []
    monkeypatch.setattr(jobs_main, "process", lambda st, **kw: ran.append("process"))
    monkeypatch.setattr(jobs_main, "publish_step", lambda st, s, conn=None: ran.append("publish") or [])
    monkeypatch.setattr(jobs_main, "refresh_step", lambda s, **kw: ran.append("refresh"))
    with pytest.raises(RuntimeError, match=r"audit: RuntimeError: 1 audit window\(s\) failed"):
        jobs_main.main(["run"], env=ENV, clock=clock)
    assert ran == ["process", "publish", "refresh"]
    st = _state(store)
    assert st["windows"][key(W3)]["status"] == "failed"
    assert st["windows_left"] == 1 and "paused_at" not in st
    # It published before it failed, so what it merged is in the reports.
    assert _position(st["published"]) == _seen(st) and "pending_high_water_mark" in st["published"]
    assert st["published"]["process_started_at"] == st["processed"]["process_started_at"]


# ---------------------------------------------------------------- carrying on
A = (datetime(2026, 9, 8, 8, tzinfo=UTC), datetime(2026, 9, 8, 16, tzinfo=UTC))
B = (datetime(2026, 9, 8, 16, tzinfo=UTC), datetime(2026, 9, 9, 0, tzinfo=UTC))
C = (datetime(2026, 9, 9, 0, tzinfo=UTC), datetime(2026, 9, 9, 8, tzinfo=UTC))
D, E, F, G = W1, W2, W3, W4
SEVEN = [_record(10 + i, when) for i, when in enumerate(
    [datetime(2026, 9, 8, 10, tzinfo=UTC), datetime(2026, 9, 8, 20, tzinfo=UTC), datetime(2026, 9, 9, 3, tzinfo=UTC),
     datetime(2026, 9, 9, 10, tzinfo=UTC), datetime(2026, 9, 9, 20, tzinfo=UTC), datetime(2026, 9, 10, 3, tzinfo=UTC),
     datetime(2026, 9, 10, 9, tzinfo=UTC)])]


def test_a_paused_reload_keeps_its_place_and_each_window_merges_once(tmp_path, monkeypatch):
    merged = []
    real_merge = audit_collect.AuditCollector.merge

    def spy(self, keys, advance_high_water=True):
        merged.append(set(keys))
        return real_merge(self, keys, advance_high_water=advance_high_water)

    monkeypatch.setattr(audit_collect.AuditCollector, "merge", spy)
    clock, store = Clock(), LocalStore(tmp_path)
    hwm = datetime(2026, 9, 10, tzinfo=UTC).isoformat()
    stale_window = (datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 9, 1, 8, tzinfo=UTC))
    stale = key(stale_window)
    stale_file = f"{audit_collect.STAGING}/win_{stale}_0000.jsonl.gz"
    store.path(stale_file).parent.mkdir(parents=True, exist_ok=True)
    store.path(stale_file).write_bytes(gzip.compress(b"{}\n"))
    store.write_json(audit_collect.STATE, {"high_water_mark": hwm, "windows": {stale: {
        "status": "succeeded", "window_start": stale_window[0].isoformat(), "window_end": stale_window[1].isoformat(),
        "completed_at": "2026-09-01T09:00:00+00:00", "merged_at": "2026-09-01T09:00:00+00:00", "rows": 1,
        "files": [stale_file]}}})

    # A two-day reload, cut off while E's query runs.
    g = SlowGraph(SEVEN, clock, hang=lambda ws, we: (ws, we) == E)
    out = collector(clocked_api(g, clock), store, clock, settings(audit_backfill_days=2), deadline=300,
                    hard_deadline=14_400).run()
    st = _state(store)
    assert g.created == [G, F, E]
    assert out["paused"] and out["windows_left"] == 5
    assert st["high_water_mark"] == hwm and st["backfill_from"].startswith("2026-09-08T12:00")
    assert stale in st["windows"] and store.path(stale_file).exists()

    # The next run picks up E's query, fetches the rest, and finishes the reload.
    g.hang = None
    out = collector(clocked_api(g, clock), store, clock).run()
    st = _state(store)
    assert g.created[3:] == [D, C, B, A]
    assert st["windows"][key(E)]["timing"]["resumed"] is True
    assert out == {"rows": 5, "days": 2}
    assert st["high_water_mark"].startswith("2026-09-10T09:00")
    for name in ("backfill_from", "loaded_back_to", "windows_left", "paused_at", "pending_high_water_mark",
                 "rebuild_when_loaded"):
        assert name not in st, name
    assert st["full_rebuild_owed"] is True
    assert stale not in st["windows"] and not store.path(stale_file).exists()
    assert len(_parsed(store)[0]) == 7

    # A window the trailing look-back fetches again merges again.
    collector(clocked_api(g, clock), store, clock, settings(audit_lookback_days=1)).run()
    assert g.created[7:] == [G, F, E, D]
    assert merged == [{key(G), key(F)}, {key(E), key(D), key(C), key(B), key(A)}, {key(D), key(E), key(F), key(G)}]
    assert len(_parsed(store)[0]) == 7


@pytest.mark.parametrize("age_hours, gone, polled_again", [(25, False, True), (27, False, False), (1, True, False)])
def test_a_paused_query_is_polled_again_for_up_to_26_hours(tmp_path, caplog, age_hours, gone, polled_again):
    caplog.set_level(logging.INFO)
    clock, store = Clock(), LocalStore(tmp_path)
    created = NOW - timedelta(hours=age_hours)
    store.write_json(audit_collect.STATE, {"windows": {key(W4): {
        "status": "paused", "window_start": W4[0].isoformat(), "window_end": W4[1].isoformat(),
        "query_id": "q-old", "query_created_at": created.isoformat(),
        "paused_at": (created + timedelta(hours=3)).isoformat(), "files": [], "pages": 0, "rows": 0}}})
    not_found = Resp(404, {"error": {"code": "NotFound", "message": "no such query"}})
    g = SlowGraph(RECORDS, clock, reply=(lambda qid, window: not_found if qid == "q-old" else None) if gone else None)
    g.queries["q-old"] = [RECORDS[3]]
    collector(clocked_api(g, clock), store, clock).run()

    assert ("q-old" in g.polls) is (age_hours < 26)
    assert (W4 in g.created) is not polled_again
    w4 = _state(store)["windows"][key(W4)]
    assert w4["status"] == "succeeded" and w4["rows"] == 1
    if gone:
        assert "can't pick up its paused query q-old" in caplog.text


def test_a_run_stopped_after_its_merge_loses_nothing(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    store = LocalStore(tmp_path)
    # Run 1 merges W3 and W4, then the replica is stopped before publish (only collect runs here).
    c1 = Clock()
    g = SlowGraph(RECORDS, c1, hang=lambda ws, we: (ws, we) == W2)
    _patch_audit(monkeypatch, c1)
    monkeypatch.setattr(graph, "collect_licensed", lambda *a, **k: None)
    budget = jobs_main.run_budget(store, {}, start=0, clock=c1, settle=True)
    jobs_main.collect(store, settings(modules=frozenset({"core"})), clocked_api(g, c1), budget=budget)
    assert c1() == 10_770 and _state(store)["merge_open"]["cutoff_s"] == 3_630.0
    # Merged, and not in the reports: `status` says so until a run publishes it.
    assert _state(store)["published"] == {} and "processed" not in _state(store)

    # Run 2 keeps more time back, processes and publishes run 1's months too, and records its own time.
    c2, seen = Clock(), []
    g.clock, g.hang = c2, (lambda ws, we: (ws, we) == W1)
    _wire(monkeypatch, store, clocked_api(g, c2), c2, seen)
    conn = sqlite3.connect(":memory:")
    monkeypatch.setattr(jobs_main, "_sql", lambda s: KeepOpen(conn, on_close=lambda: c2.advance(50)))
    monkeypatch.setattr(jobs_main, "refresh_step", lambda s, **kw: None)
    assert jobs_main.main(["run"], env=ENV, clock=c2) == 0
    assert "stopped before it published" in caplog.text and "keeps at least 91 min back" in caplog.text
    assert seen[-1]["deadline"] == 14_400 - 1.5 * 3_630
    st = _state(store)
    assert st["windows"][key(W2)]["timing"]["resumed"] is True and g.created.count(W2) == 1
    assert st["windows"][key(W1)]["status"] == "paused"
    assert conn.execute("SELECT count(*) FROM copilot_interactions_curated").fetchone() == (3,)
    assert st["last_merge_to_publish_s"] == 50.0 and "merge_open" not in st
    assert _position(st["published"]) == _seen(st) and "pending_high_water_mark" in st["published"]


# ---------------------------------------------------------------- months merged out of order (#31)
TITLE = "T_11111111-2222-3333-4444-555555555555"
SCHEMA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
JUL, AUG = datetime(2026, 7, 1, tzinfo=UTC), datetime(2026, 8, 1, tzinfo=UTC)


def _agent_record(i, when, agent_id):
    r = _record(i, when)
    r["auditData"]["AgentId"] = agent_id
    return r


# June names the agent as `T_<title>.<schema>`; July only by its schema GUID, which links through June's record.
HISTORY = [
    _agent_record(1, datetime(2026, 6, 10, 9, tzinfo=UTC), f"{TITLE}.{SCHEMA}"),
    _record(2, datetime(2026, 6, 20, 9, tzinfo=UTC)),
    _agent_record(3, datetime(2026, 7, 15, 9, tzinfo=UTC), SCHEMA),
    _record(4, datetime(2026, 7, 20, 9, tzinfo=UTC)),
    _record(5, datetime(2026, 8, 12, 9, tzinfo=UTC)),
    _record(6, datetime(2026, 9, 9, 9, tzinfo=UTC)),
]
HISTORY_ENV = {"VALUELENS_MODULES": "core", "VALUELENS_AUDIT_HISTORY_DAYS": "100",
               "VALUELENS_AUDIT_LOOKBACK_DAYS": "0", "VALUELENS_AUDIT_TIME_BUDGET_MIN": "5"}


def _registry(store):
    write_rows(store.path("raw/agents_365/part-0.parquet"), ["Title ID"], [(TITLE,)])
    return store


def _links(store):
    glob = f"read_parquet('{store.path(CURATED).as_posix()}/*.parquet', union_by_name=true)"
    return dict(duckdb.sql(f"SELECT strftime(CreationDate, '%Y-%m-%d'), Agent_LinkMethod FROM {glob} "
                           f"WHERE Agent_LinkMethod IS NOT NULL").fetchall())


@pytest.mark.parametrize("timeout", [None, "7000"])
def test_a_history_loaded_newest_first_curates_like_one_pass(tmp_path, monkeypatch, caplog, timeout):
    caplog.set_level(logging.INFO)
    clock = Clock()
    g = SlowGraph(HISTORY, clock)
    api = clocked_api(g, clock)
    monkeypatch.setattr(jobs_main, "_api", lambda s: api)
    monkeypatch.setattr(graph, "collect_licensed", lambda *a, **k: None)
    _patch_audit(monkeypatch, clock, chunk_hours=168)

    def run(store, env=HISTORY_ENV):
        return jobs_main.main(["run", "--steps", "collect,process", "--data-dir", str(store.root)], env=env,
                              clock=clock)

    # One pass over the whole history.
    base = _registry(LocalStore(tmp_path / "one-pass"))
    assert run(base) == 0
    assert _links(base) == {"2026-06-10": "Title ID", "2026-07-15": "Schema GUID"}

    # Newest weeks first: August on, then July, then the rest.
    env = dict(HISTORY_ENV, **({"VALUELENS_JOB_TIMEOUT_SEC": timeout} if timeout else {}))
    store = _registry(LocalStore(tmp_path / "newest-first"))
    for hang in (lambda ws, we: ws < AUG, lambda ws, we: ws < JUL):
        g.hang = hang
        assert run(store, env) == 0
        assert _state(store)["windows_left"] > 0 and _state(store)["rebuild_when_loaded"] is True
    # July was curated before June's record linked its agent.
    assert _links(store) == {"2026-07-15": "Unlinked"}
    g.hang = None
    assert run(store, env) == 0
    st = _state(store)
    assert "windows_left" not in st and "rebuild_when_loaded" not in st
    if timeout is None:
        # The run that finishes the history rebuilds the tables once.
        assert "full_rebuild_owed" not in st
        assert "rebuilding every month once" in caplog.text
    else:
        # Not enough time left in that run (twice the 60-minute reserve): the next run rebuilds.
        assert st["full_rebuild_owed"] is True and st["full_rebuild_deferred"] is True
        assert _links(store) == {"2026-06-10": "Title ID", "2026-07-15": "Unlinked"}
        assert _curated(store) != _curated(base)
        assert run(store, env) == 0
        st = _state(store)
        assert "full_rebuild_owed" not in st and "full_rebuild_deferred" not in st
    assert _links(store) == _links(base)
    assert _curated(store) == _curated(base)


# ---------------------------------------------------------------- the refresh (#67)
MODEL = {"m1": {"workspaceId": WS, "itemId": "ds-1"}}
TWO_MODELS = {**MODEL, "m2": {"workspaceId": WS, "itemId": "ds-2"}}


def _refresh(handler, clock, models=MODEL, **kw):
    return refresh_mod.refresh_models(clocked_api(handler, clock), settings(semantic_models=models),
                                      sleep=clock.sleep, clock=clock, **kw)


def _running(method, url, kw):
    if method == "POST":
        return Resp(202, headers={"Location": f"{url}/rid-1"})
    return Resp(202, {"status": "Unknown", "extendedStatus": "InProgress"})


def test_the_refresh_stops_waiting_at_the_runs_deadline(caplog):
    caplog.set_level(logging.INFO)
    # Another refresh is running.
    clock = Clock()
    busy = Resp(409, text="Another refresh is in progress")
    assert _refresh(lambda m, u, kw: busy, clock, deadline=100) == []
    assert clock.slept == [60] and "m1 didn't start before the run's time limit" in caplog.text

    # This run's refresh is still going: it carries on in Power BI, and the run doesn't fail for it.
    caplog.clear()
    clock = Clock()
    assert _refresh(_running, clock, deadline=100) == []
    assert clock.slept == [30, 30, 30]
    assert "m1 is still running at the run's time limit; it carries on in Power BI" in caplog.text

    # A throttled request stops at the deadline too.
    caplog.clear()
    clock = Clock()
    throttled = Resp(429, {}, headers={"Retry-After": "120"})
    assert _refresh(lambda m, u, kw: throttled, clock, deadline=100) == []
    assert clock.slept == [] and "m1 didn't start" in caplog.text

    # The 120-minute limit per refresh is unchanged.
    assert refresh_mod.Refresher(None).timeout_minutes == 120


def test_a_full_refresh_cut_off_is_owed_to_the_next_run(tmp_path):
    store = LocalStore(tmp_path)
    # Older days were republished; m1's full refresh is still running at the deadline and m2's never started.
    assert _refresh(_running, Clock(), TWO_MODELS, all_partitions=True, store=store, deadline=100) == []
    assert store.read_json(refresh_mod.REFRESH_STATE, {}) == {"full_refresh_owed": {
        "m1": {"refresh_id": "rid-1", "enhanced": True}, "m2": {"refresh_id": None, "enhanced": None}}}

    bodies, ended = [], {"rid-1": "Failed"}

    def handler(method, url, kw):
        if method == "POST":
            bodies.append(kw["json"])
            return Resp(202, headers={"Location": f"{url}/rid-{len(bodies) + 1}"})
        return Resp(200, {"extendedStatus": ended.get(url.rsplit("/", 1)[-1], "Completed")})

    # The next run's publish needs no full refresh, but m1's ended without completing: both are full.
    api, _ = make_api(handler)
    assert jobs_main.refresh_step(settings(semantic_models=TWO_MODELS), api=api, store=store) == ["m1", "m2"]
    assert bodies == [refresh_mod.ENHANCED_ALL, refresh_mod.ENHANCED_ALL]
    assert store.read_json(refresh_mod.REFRESH_STATE, {}) == {"full_refresh_owed": {}}

    # One a run saw complete is no longer owed.
    store.write_json(refresh_mod.REFRESH_STATE, {"full_refresh_owed": {"m1": {"refresh_id": "rid-1",
                                                                                "enhanced": True}}})
    ended["rid-1"] = "Completed"
    bodies.clear()
    assert jobs_main.refresh_step(settings(semantic_models=MODEL), api=api, store=store) == ["m1"]
    assert bodies == [refresh_mod.ENHANCED]
    assert store.read_json(refresh_mod.REFRESH_STATE, {}) == {"full_refresh_owed": {}}

    # Without the store (a refresh-only run), nothing owed is carried over.
    store.write_json(refresh_mod.REFRESH_STATE, {"full_refresh_owed": {"m1": {"refresh_id": None,
                                                                                "enhanced": None}}})
    bodies.clear()
    assert jobs_main.refresh_step(settings(semantic_models=MODEL), api=api) == ["m1"]
    assert bodies == [refresh_mod.ENHANCED]


# ---------------------------------------------------------------- settings
@pytest.mark.parametrize("value", [None, "", "abc", "0", "-5", "nan", "inf"])
def test_the_job_assumes_14400_seconds_without_a_usable_timeout(value):
    env = {} if value is None else {"VALUELENS_JOB_TIMEOUT_SEC": value}
    b = jobs_main.run_budget(None, env, start=0, clock=Clock())
    assert b.timeout_s == 14_400 and b.hard_deadline == 14_400 and b.fetch_deadline == 10_800


@pytest.mark.parametrize("value, fetch", [("300", 14_400), ("0", 0), ("-5", 10_800), ("nan", 10_800),
                                          ("90", 5_400)])
def test_the_audit_budget_override_counts_minutes_from_the_jobs_start(value, fetch):
    b = jobs_main.run_budget(None, {"VALUELENS_AUDIT_TIME_BUDGET_MIN": value}, start=0, clock=Clock())
    assert b.fetch_deadline == fetch


def test_a_reserve_longer_than_the_run_leaves_no_fetch_time(tmp_path):
    store = LocalStore(tmp_path)
    store.write_json(audit_collect.STATE, {"last_merge_to_publish_s": 20_000})
    assert jobs_main.run_budget(store, {}, start=7, clock=Clock(7)).fetch_deadline == 7


# ---------------------------------------------------------------- finding 40: org-scoped access while loading
def test_a_paused_first_load_applies_org_scoped_access(tmp_path, monkeypatch):
    clock, store = Clock(), LocalStore(tmp_path)
    path = store.path(jobs_access.ACCESS_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(CSV, encoding="utf-8")
    order = []

    def collect_org(api, st, s, **kw):
        order.append("org")
        write_rows(st.path("raw/copilot_org_data/part-0.parquet"), ["PersonId", "managerUPN", "OrgPath"],
                   [("ceo@contoso.com", "", "ceo@contoso.com"), ("vp@contoso.com", "ceo@contoso.com", ""),
                    ("ic@contoso.com", "vp@contoso.com", None)])

    g = SlowGraph(RECORDS, clock, hang=lambda ws, we: (ws, we) == W2)
    seen = []
    _wire(monkeypatch, store, clocked_api(g, clock), clock, seen)
    monkeypatch.setattr(graph, "collect_org", collect_org)
    conn = sqlite3.connect(":memory:")
    _access_tables(conn)
    monkeypatch.setattr(jobs_main, "_sql", lambda s: KeepOpen(conn))
    monkeypatch.setattr(jobs_main, "refresh_step", lambda s, **kw: None)
    env = dict(ENV, VALUELENS_MODULES="core,orgData", VALUELENS_AUDIT_TIME_BUDGET_MIN="5")
    assert jobs_main.main(["run", "--steps", "collect,process,publish,refresh"], env=env, clock=clock) == 0

    assert order == ["org"] and len(seen) == 1
    assert _state(store)["windows"][key(W2)]["status"] == "paused"
    assert conn.execute("SELECT count(*) FROM access_scope").fetchone() == (3,)
    assert conn.execute("SELECT count(*) FROM access_people").fetchone() == (3,)
    assert conn.execute("SELECT count(*) FROM copilot_interactions_curated").fetchone() == (2,)


# ---------------------------------------------------------------- what `status` counts as in the reports
HWM_1 = "2026-09-09T09:00:00+00:00"
HWM_2 = "2026-09-10T09:00:00+00:00"


def _fake_steps(monkeypatch, store, fail=None, during_process=None):
    """main() over `store`, with process and publish as fakes (`fail` names the one that raises) and no refresh."""
    def step(name, then=None):
        def fake(st, *a, **kw):
            if then is not None:
                then(st)
            if name == fail:
                raise RuntimeError(f"{name} failed")
            return []
        return fake

    monkeypatch.setattr(jobs_main, "open_store", lambda data_dir, s: store)
    monkeypatch.setattr(jobs_main, "process", step("process", during_process))
    monkeypatch.setattr(jobs_main, "publish_step", step("publish"))
    monkeypatch.setattr(jobs_main, "refresh_step", lambda s, **kw: None)


def test_a_run_records_what_it_published_only_once_its_publish_has_finished(tmp_path, monkeypatch):
    clock, store = Clock(), LocalStore(tmp_path)
    _wire(monkeypatch, store, clocked_api(SlowGraph(RECORDS, clock), clock), clock)
    during = {}

    def process(st, **kw):
        during["process"] = _state(st)

    def publish(st, s, conn=None):
        during["publish"] = _state(st)
        return []

    monkeypatch.setattr(jobs_main, "process", process)
    monkeypatch.setattr(jobs_main, "publish_step", publish)
    monkeypatch.setattr(jobs_main, "refresh_step", lambda s, **kw: None)
    assert jobs_main.main(["run"], env=ENV, clock=clock) == 0
    st = _state(store)
    assert _seen(st) == {"high_water_mark": st["high_water_mark"]}
    # The process step curates what was merged when it starts, and the record of that follows once it has finished.
    assert _seen(during["process"]) == _seen(st) and "processed" not in during["process"]
    # Nothing was in the reports before this run (a fresh install), and the record says so until its publish ends.
    assert during["publish"]["published"] == {} and _position(during["publish"]["processed"]) == _seen(st)
    assert st["published"] == dict(st["processed"], published_at=st["published"]["published_at"])
    started, published = (datetime.fromisoformat(st["published"][k]) for k in ("process_started_at", "published_at"))
    assert started <= published


def test_a_run_that_stops_before_its_publish_ends_leaves_the_published_record(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    processed = {"high_water_mark": HWM_1, "process_started_at": "2026-09-09T12:00:00+00:00"}
    published = dict(processed, published_at="2026-09-09T12:30:00+00:00")
    store.write_json(audit_collect.STATE, {"high_water_mark": HWM_2, "processed": processed, "published": published})

    def run(steps, fail=None):
        _fake_steps(monkeypatch, store, fail)
        if fail is None:
            assert jobs_main.main(["run", "--steps", steps], env=ENV) == 0
        else:
            with pytest.raises(RuntimeError, match=f"{fail} failed"):
                jobs_main.main(["run", "--steps", steps], env=ENV)
        return _state(store)

    # Its process step failed, or the run was stopped at its hard deadline during it: no publish carries it.
    st = run("process,publish", fail="process")
    assert st["processed"] == processed and st["published"] == published
    # Its publish failed, or the run was stopped during it.
    st = run("process,publish", fail="publish")
    assert _position(st["processed"]) == {"high_water_mark": HWM_2} and st["published"] == published
    # A run that publishes without processing carries the output of the last process step to finish.
    last = st["processed"]
    st = run("publish")
    assert st["published"] == dict(last, published_at=st["published"]["published_at"])
    # With no process step on record, it records nothing.
    store.write_json(audit_collect.STATE, {"high_water_mark": HWM_2, "published": published})
    st = run("publish")
    assert st["published"] == published and "processed" not in st


def test_overlapping_runs_count_as_published_only_what_was_merged_when_the_process_step_started(tmp_path,
                                                                                                monkeypatch):
    store = LocalStore(tmp_path)
    store.write_json(audit_collect.STATE, {"high_water_mark": HWM_1, "published": {}})

    def merged_meanwhile(st):
        # There's no run lock yet: another run merges newer windows while this one processes.
        st.write_json(audit_collect.STATE, dict(_state(st), high_water_mark=HWM_2))

    _fake_steps(monkeypatch, store, during_process=merged_meanwhile)
    assert jobs_main.main(["run", "--steps", "process,publish"], env=ENV) == 0
    st = _state(store)
    assert st["high_water_mark"] == HWM_2
    assert _position(st["processed"]) == _position(st["published"]) == {"high_water_mark": HWM_1}


OLDER_ENTRY = {"status": "succeeded", "window_start": W4[0].isoformat(), "window_end": W4[1].isoformat(),
               "completed_at": "2026-09-10T12:30:00+00:00", "rows": 1, "files": []}
OLDER_RELOAD = "2026-09-01T12:00:00+00:00"


@pytest.mark.parametrize("state, published", [
    # An older image's state: its runs published what they merged, and it kept no record of that.
    ({"high_water_mark": HWM_1, "windows": {key(W4): OLDER_ENTRY}}, {"high_water_mark": HWM_1}),
    # ...with a reload its runs hadn't merged all of.
    ({"high_water_mark": HWM_1, "backfill_from": OLDER_RELOAD},
     {"high_water_mark": HWM_1, "backfill_from": OLDER_RELOAD}),
    # A fresh install, or an older image's first load cut off before it merged: nothing is in the reports.
    ({}, {}),
    ({"windows": {key(W4): OLDER_ENTRY}}, {}),
    # A state this image has written stays as it is: its record, or a window it merged before any record.
    ({"high_water_mark": HWM_2, "published": {"high_water_mark": HWM_1}}, {"high_water_mark": HWM_1}),
    ({"high_water_mark": HWM_1, "windows": {key(W4): dict(OLDER_ENTRY, merged_at=None)}}, None),
])
def test_this_images_first_run_counts_what_an_older_image_merged_as_published(tmp_path, state, published):
    store = LocalStore(tmp_path)
    store.write_json(audit_collect.STATE, state)
    # The record is taken before the run remembers a reload asked for now, which isn't in the reports.
    audit_collect.remember_backfill(store, settings(audit_backfill_days=2), now=NOW)
    st = _state(store)
    assert st.get("published") == published
    assert st["backfill_from"] == state.get("backfill_from", (NOW - timedelta(days=2)).isoformat())
