"""The Azure run job carries a long load on: a run that paused on its time budget starts the next run itself.

`decide` runs under the run lock and counts the start in raw/_state/chain.json; `start` calls Jobs - Start after
the release. Azure is faked at the HTTP-session level and the credential is a stand-in, so no sign-in is needed.
"""
from __future__ import annotations

import logging
import sys
import time
from datetime import datetime, timedelta, timezone
from types import ModuleType, SimpleNamespace

import pytest

from test_azure_jobs import Resp
from test_azure_run_lock import ENV, _held_by, _hold, _steps
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import continue_run, runlock
from valuelens_jobs.api import ARM
from valuelens_jobs.storage import LocalStore

UTC = timezone.utc
NOW = datetime(2026, 10, 24, 6, 30, tzinfo=UTC)
JOB_ID = ("/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-ah/providers/Microsoft.App/jobs/"
          "ah-run")
START_URL = f"https://management.azure.com{JOB_ID}/start?api-version=2024-03-01"
CHAINED = dict(ENV, VALUELENS_RUN_JOB_ID=JOB_ID)
PAUSED = {"rows": 10, "days": 3, "paused": True, "windows_left": 5, "windows_loaded": 2,
          "loaded_back_to": "2026-10-20T00:00:00+00:00"}


def _lines(caplog, level=None):
    return [r.getMessage() for r in caplog.records
            if r.name == "valuelens_jobs.continue_run" and (level is None or r.levelno == level)]


# ---------------------------------------------------------------- decide: whether to start the next run
@pytest.mark.parametrize("audit", [None, {}, {"rows": 3, "days": 1}, {"paused": False, "windows_loaded": 2}, "x"])
def test_only_a_run_that_paused_starts_the_next(tmp_path, audit, caplog):
    caplog.set_level(logging.INFO)
    store = LocalStore(tmp_path)
    assert continue_run.decide(store, CHAINED, audit, now=NOW) is None
    assert not store.path(continue_run.CHAIN).exists() and _lines(caplog) == []


def test_a_run_that_loaded_no_window_doesnt_start_the_next(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    store = LocalStore(tmp_path)
    assert continue_run.decide(store, CHAINED, dict(PAUSED, windows_loaded=0), now=NOW) is None
    assert not store.path(continue_run.CHAIN).exists()
    assert _lines(caplog) == ["run: this run loaded no window of the history before its time budget, so it doesn't "
                              "start the next run; the next scheduled run carries on (5 windows left)"]


@pytest.mark.parametrize("value", [None, "", "  "])
def test_a_job_without_its_own_id_doesnt_start_the_next(tmp_path, value, caplog):
    caplog.set_level(logging.INFO)
    store = LocalStore(tmp_path)
    env = dict(ENV) if value is None else dict(ENV, VALUELENS_RUN_JOB_ID=value)
    assert continue_run.decide(store, env, PAUSED, now=NOW) is None
    assert not store.path(continue_run.CHAIN).exists()
    assert _lines(caplog) == ["run: VALUELENS_RUN_JOB_ID isn't set (a job deployed before 0.6.9), so the next "
                              "scheduled run carries on with the history (5 windows left)"]


def test_runs_start_the_next_up_to_eight_a_day(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    store = LocalStore(tmp_path)
    for n in range(1, continue_run.MAX_A_DAY + 1):
        at = NOW + timedelta(hours=n)
        assert continue_run.decide(store, dict(CHAINED, CONTAINER_APP_JOB_EXECUTION_NAME=f"ah-run-{n}"), PAUSED,
                                   now=at) == JOB_ID
        assert store.read_json(continue_run.CHAIN) == {"day": "2026-10-24", "count": n,
                                                       "at": at.isoformat(timespec="seconds"),
                                                       "execution": f"ah-run-{n}"}
    assert _lines(caplog)[0] == ("run: the history isn't all loaded (5 windows left), so this run starts the next one "
                                 "once it has released the run lock (1 of 8 today, UTC)")
    caplog.clear()
    # The ninth that day leaves the load to the next scheduled run.
    assert continue_run.decide(store, CHAINED, PAUSED, now=NOW + timedelta(hours=17)) is None
    assert store.read_json(continue_run.CHAIN)["count"] == 8
    assert _lines(caplog) == ["run: 8 runs have started the next one today (UTC), the most a day, so the next "
                              "scheduled run carries on (5 windows left)"]


def test_the_count_starts_again_each_day_utc(tmp_path):
    store = LocalStore(tmp_path)
    store.write_json(continue_run.CHAIN, {"day": "2026-10-23", "count": 8})
    # 01:30 in UTC+2 is still the day before in UTC, which is full.
    assert continue_run.decide(store, CHAINED, PAUSED,
                               now=datetime(2026, 10, 24, 1, 30, tzinfo=timezone(timedelta(hours=2)))) is None
    assert continue_run.decide(store, CHAINED, PAUSED, now=NOW) == JOB_ID
    assert store.read_json(continue_run.CHAIN)["day"] == "2026-10-24"
    assert store.read_json(continue_run.CHAIN)["count"] == 1


@pytest.mark.parametrize("content", ["not json", "[1, 2]", '{"day": "2026-10-24", "count": "many"}',
                                     '{"day": "2026-10-24", "count": -3}'])
def test_a_count_that_cant_be_read_starts_again(tmp_path, content):
    store = LocalStore(tmp_path)
    path = store.path(continue_run.CHAIN)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    assert continue_run.decide(store, CHAINED, PAUSED, now=NOW) == JOB_ID
    assert store.read_json(continue_run.CHAIN)["count"] == 1


@pytest.mark.parametrize("broken", ["read_json", "write_json"])
def test_a_count_that_cant_be_kept_doesnt_start_the_next(tmp_path, broken, caplog):
    caplog.set_level(logging.INFO)
    store = LocalStore(tmp_path)

    def fail(*a, **k):
        raise OSError("storage is down")

    setattr(store, broken, fail)
    assert continue_run.decide(store, CHAINED, PAUSED, now=NOW) is None
    assert _lines(caplog) == ["run: couldn't count the next run in raw/_state/chain.json (OSError: storage is down), "
                              "so this run doesn't start it; the next scheduled run carries on"]


# ---------------------------------------------------------------- start: Jobs - Start, with no body
class Credential:
    """Stands in for ManagedIdentityCredential: records the scopes it's asked for."""

    def __init__(self, fail=None):
        self.scopes, self.fail = [], fail

    def get_token(self, *scopes):
        self.scopes.append(scopes)
        if self.fail is not None:
            raise self.fail
        return SimpleNamespace(token="arm-token", expires_on=time.time() + 3600)


class StartSession:
    """Replies in turn from `replies` (a Resp, or an exception to raise); records every call, with its timeout."""

    def __init__(self, *replies, events=None):
        self.replies, self.calls, self.events = list(replies), [], events

    def request(self, method, url, headers=None, timeout=None, **kw):
        self.calls.append({"method": method, "url": url, "headers": headers, "timeout": timeout, "kw": kw})
        if self.events is not None:
            self.events.append("start")
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def test_the_start_posts_no_body_with_the_jobs_own_arm_token(caplog):
    caplog.set_level(logging.INFO)
    credential, slept = Credential(), []
    session = StartSession(Resp(200, {"name": "ah-run-0930c", "id": f"{JOB_ID}/executions/ah-run-0930c"}))
    assert continue_run.start(JOB_ID, credential=credential, session=session, sleep=slept.append) is True
    assert credential.scopes == [(ARM,)]
    [call] = session.calls
    assert call["method"] == "POST" and call["url"] == START_URL
    # No body at all: a body, even {}, is a template override.
    assert call["kw"] == {}
    assert call["headers"] == {"Authorization": "Bearer arm-token"}
    assert call["timeout"] == continue_run.TIMEOUT and max(continue_run.TIMEOUT) <= 30
    assert slept == [] and _lines(caplog) == ["run: started the next run (ah-run-0930c)"]


def test_an_accepted_start_without_a_body_counts(caplog):
    caplog.set_level(logging.INFO)
    session = StartSession(Resp(202, headers={"Location": "https://management.azure.com/operations/1"}))
    assert continue_run.start(JOB_ID, credential=Credential(), session=session) is True
    assert _lines(caplog) == ["run: started the next run"]


def test_the_start_uses_the_jobs_system_assigned_identity(monkeypatch):
    built = []

    class ManagedIdentityCredential(Credential):
        def __init__(self, *args, **kwargs):
            super().__init__()
            built.append((args, kwargs))

    fake = ModuleType("azure.identity")
    fake.ManagedIdentityCredential = ManagedIdentityCredential
    monkeypatch.setitem(sys.modules, "azure.identity", fake)
    session = StartSession(Resp(200, {"name": "ah-run-0930c"}))
    assert continue_run.start(JOB_ID, session=session) is True
    # No client ID, so not the user-assigned identity the job shares with the web app (AZURE_CLIENT_ID).
    assert built == [((), {})]


def test_a_start_that_isnt_allowed_yet_only_warns(caplog):
    caplog.set_level(logging.INFO)
    session = StartSession(Resp(403, {"error": {"code": "AuthorizationFailed"}}))
    assert continue_run.start(JOB_ID, credential=Credential(), session=session, sleep=lambda s: None) is False
    assert len(session.calls) == 1
    assert _lines(caplog) == [
        "run: couldn't start the next run: the run job's own identity isn't allowed to start it yet (HTTP 403), so "
        "the next scheduled run carries on. An admin can let it start straight away: see the pending admin action "
        "in the installer's \"status\""]
    assert [r.levelno for r in caplog.records if r.name == "valuelens_jobs.continue_run"] == [logging.WARNING]


@pytest.mark.parametrize("replies, calls, error", [
    ((Resp(500, text="busy"), Resp(503, text="busy")), 2, "HttpError: start the next run: HTTP 503 busy"),
    ((ConnectionError("reset"), ConnectionError("reset")), 2, "ConnectionError: reset"),
    ((Resp(404, text="no such job"),), 1, "HttpError: start the next run: HTTP 404 no such job"),
])
def test_a_start_that_fails_only_warns(replies, calls, error, caplog):
    caplog.set_level(logging.INFO)
    slept = []
    session = StartSession(*replies)
    assert continue_run.start(JOB_ID, credential=Credential(), session=session, sleep=slept.append) is False
    # One retry, after a short wait.
    assert len(session.calls) == calls and slept == [2.0] * (calls - 1)
    assert _lines(caplog, logging.WARNING) == [
        f"run: couldn't start the next run ({error}), so the next scheduled run carries on"]


def test_a_token_that_cant_be_had_only_warns(caplog):
    session = StartSession()
    credential = Credential(fail=RuntimeError("ManagedIdentityCredential authentication unavailable"))
    assert continue_run.start(JOB_ID, credential=credential, session=session) is False
    assert session.calls == []
    assert _lines(caplog, logging.WARNING) == [
        "run: couldn't start the next run (RuntimeError: ManagedIdentityCredential authentication unavailable), so "
        "the next scheduled run carries on"]


def test_the_start_waits_first_when_asked(caplog):
    caplog.set_level(logging.INFO)
    events = []
    session = StartSession(Resp(200, {"name": "ah-run-0930c"}), events=events)
    assert continue_run.start(JOB_ID, wait=60, credential=Credential(), session=session,
                              sleep=lambda s: events.append(("slept", s))) is True
    assert events == [("slept", 60), "start"]
    assert _lines(caplog)[0] == "run: waiting 60 s for the run lock to lapse before starting the next run"


# ---------------------------------------------------------------- main: counted under the lock, started after it
def _chain(monkeypatch, store, audit=PAUSED, started=True, fail=None):
    """main() over `store` with every step faked and collect returning `audit`. Returns the steps run, the
    decisions, each with the lock's holder at the time, and the starts, each with its wait and the lock's holder."""
    ran = _steps(monkeypatch, store, fail=fail)
    monkeypatch.setattr(jobs_main, "collect", lambda *a, **k: ran.append(("collect", _held_by(store))) or
                        {"audit": audit})
    decided, starts = [], []
    real = continue_run.decide

    def decide(*a, **k):
        job = real(*a, **k)
        decided.append((job, _held_by(store)))
        return job

    monkeypatch.setattr(continue_run, "decide", decide)
    monkeypatch.setattr(continue_run, "start",
                        lambda job, wait=0.0: starts.append((job, wait, _held_by(store))) or started)
    return ran, decided, starts


def test_a_paused_load_starts_the_next_run_once_the_lock_is_released(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    ran, decided, starts = _chain(monkeypatch, store)
    assert jobs_main.main(["run"], env=CHAINED) == 0
    me = runlock.lease_id(CHAINED)
    assert [step for step, _ in ran] == ["collect", "process", "publish", "refresh"]
    # Counted while this run held the lock, after every step; started once it was released.
    assert decided == [(JOB_ID, me)]
    assert starts == [(JOB_ID, 0, None)]
    assert store.read_json(continue_run.CHAIN)["count"] == 1


def test_a_release_that_failed_waits_for_the_lock_to_lapse(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    _, _, starts = _chain(monkeypatch, store)
    real = runlock.RunLock.release
    monkeypatch.setattr(runlock.RunLock, "release", lambda self: real(self) and False)
    assert jobs_main.main(["run"], env=CHAINED) == 0
    assert starts == [(JOB_ID, runlock.LEASE_SEC, None)]


def test_a_start_that_failed_leaves_the_exit_code(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    _, _, starts = _chain(monkeypatch, store, started=False)
    assert jobs_main.main(["run"], env=CHAINED) == 0
    assert len(starts) == 1


def test_a_run_with_errors_starts_nothing(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    _, decided, starts = _chain(monkeypatch, store)
    monkeypatch.setattr(jobs_main, "collect", lambda *a, **k: {"errors": {"licensed": "boom"}, "audit": PAUSED})
    with pytest.raises(RuntimeError, match="licensed: boom"):
        jobs_main.main(["run"], env=CHAINED)
    assert decided == [] and starts == [] and not store.path(continue_run.CHAIN).exists()


@pytest.mark.parametrize("fail", ["process", "publish", "refresh"])
def test_a_run_whose_step_failed_starts_nothing(tmp_path, monkeypatch, fail):
    store = LocalStore(tmp_path)
    _, decided, starts = _chain(monkeypatch, store, fail=fail)
    with pytest.raises(RuntimeError, match=f"{fail} failed"):
        jobs_main.main(["run"], env=CHAINED)
    assert decided == [] and starts == [] and not store.path(continue_run.CHAIN).exists()


@pytest.mark.parametrize("steps", ["process,publish,refresh", "access,refresh", "publish"])
def test_a_run_that_doesnt_collect_starts_nothing(tmp_path, monkeypatch, steps):
    store = LocalStore(tmp_path)
    _, decided, starts = _chain(monkeypatch, store)
    assert jobs_main.main(["run", "--steps", steps], env=CHAINED) == 0
    assert decided == [] and starts == []


def test_a_sample_run_starts_nothing(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    _, decided, starts = _chain(monkeypatch, store)
    loaded = []
    sample = ModuleType("valuelens_jobs.sample")
    sample.load = lambda *a, **k: loaded.append(True)
    monkeypatch.setitem(sys.modules, "valuelens_jobs.sample", sample)
    assert jobs_main.main(["run"], env=dict(CHAINED, VALUELENS_SAMPLE_DATA="true")) == 0
    assert loaded == [True] and decided == [] and starts == []


def test_a_run_whose_load_is_done_starts_nothing(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    _, decided, starts = _chain(monkeypatch, store, audit={"rows": 10, "days": 3})
    assert jobs_main.main(["run"], env=CHAINED) == 0
    assert decided == [(None, runlock.lease_id(CHAINED))] and starts == []


def test_a_next_run_that_finds_the_lock_held_stops_and_starts_nothing(tmp_path, monkeypatch, caplog):
    # Another run is going, one started by hand say: it carries the load on, and starts its own next run.
    store = LocalStore(tmp_path)
    _, decided, starts = _chain(monkeypatch, store)
    _hold(store)
    assert jobs_main.main(["run"], env=CHAINED) == 0
    assert decided == [] and starts == []
    assert "That run loads and publishes the history, so nothing is lost." in caplog.text
