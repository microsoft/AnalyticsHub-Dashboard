"""The Azure run job's run lock: a run that starts while another is going stops straight away.

Runs go through main() with the steps faked. LocalStore's file lease stands in for the blob lease in most tests;
the AdlsStore tests fake the blob client with Lease Blob's rules, so no storage account is needed.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from enum import Enum
from types import SimpleNamespace

import pytest

from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import runlock
from valuelens_jobs.collect import audit as audit_collect
from valuelens_jobs.storage import AdlsStore, LeaseHeld, LocalStore

LOCK = runlock.LOCK
JOB = {"CONTAINER_APP_JOB_NAME": "ah-run", "CONTAINER_APP_JOB_EXECUTION_NAME": "ah-run-0300a"}
ENV = dict(JOB, VALUELENS_MODULES="core", VALUELENS_AUDIT_HISTORY_DAYS="1", VALUELENS_AUDIT_LOOKBACK_DAYS="0")
OTHER = {"execution": "ah-run-1000b", "job": "ah-run", "since": "2026-10-23T10:00:00+00:00",
         "steps": ["collect", "process", "publish", "refresh"]}
# The audit state as a run left it when it was stopped between its merge and its publish: a run that collects
# settles it before its first step (see run_budget), so it shows whether a run changed any state.
STOPPED_MID_MERGE = {"high_water_mark": "2026-10-22T00:00:00+00:00",
                     "merge_open": {"started_at": "2026-10-22T05:00:00+00:00", "cutoff_s": 1800.0}}


def _steps(monkeypatch, store, fail=None):
    """main() over `store` with every step faked. Returns the steps run, each with whether the lock was held."""
    ran = []

    def step(name, result=None):
        def fake(*a, **kw):
            ran.append((name, _held_by(store)))
            if name == fail:
                raise RuntimeError(f"{name} failed")
            return result
        return fake

    monkeypatch.setattr(jobs_main, "open_store", lambda data_dir, s: store)
    monkeypatch.setattr(jobs_main, "collect", step("collect", {}))
    monkeypatch.setattr(jobs_main, "process", step("process"))
    monkeypatch.setattr(jobs_main, "publish_step", step("publish", []))
    monkeypatch.setattr(jobs_main, "access_step", step("access"))
    monkeypatch.setattr(jobs_main, "refresh_step", step("refresh"))
    return ran


def _held_by(store):
    """The lease ID LocalStore's lock file names, or None without one."""
    p = store.path(LOCK)
    return json.loads(p.read_text(encoding="utf-8"))["id"] if p.is_file() else None


def _hold(store, lease="other", holder=OTHER, seconds=60):
    """Another run's live lock."""
    return store.acquire_lease(LOCK, lease, seconds, holder)


def _stopped_lines(caplog):
    return [r.getMessage() for r in caplog.records
            if r.name == "valuelens_jobs.runlock" and "stopped before any step" in r.getMessage()]


# ---------------------------------------------------------------- holding the lock
def test_a_run_holds_the_lock_through_every_step_and_releases_it(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    store = LocalStore(tmp_path)
    ran = _steps(monkeypatch, store)
    assert jobs_main.main(["run"], env=ENV) == 0
    me = runlock.lease_id(ENV)
    assert ran == [(step, me) for step in ("collect", "process", "publish", "refresh")]
    assert not store.path(LOCK).exists()
    assert any("released the run lock" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("fail", ["collect", "process", "publish", "refresh"])
def test_a_run_that_fails_releases_the_lock(tmp_path, monkeypatch, fail):
    store = LocalStore(tmp_path)
    _steps(monkeypatch, store, fail=fail)
    with pytest.raises(RuntimeError, match=f"{fail} failed"):
        jobs_main.main(["run"], env=ENV)
    assert not store.path(LOCK).exists()
    # The next run takes it straight away.
    _steps(monkeypatch, store)
    assert jobs_main.main(["run"], env=dict(ENV, CONTAINER_APP_JOB_EXECUTION_NAME="ah-run-0300b")) == 0


def test_a_run_whose_sources_failed_releases_the_lock_before_it_fails(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    ran = _steps(monkeypatch, store)
    monkeypatch.setattr(jobs_main, "collect", lambda *a, **k: ran.append("collect") or {"errors": {"audit": "boom"}})
    held = []
    real = runlock.RunLock.release
    monkeypatch.setattr(runlock.RunLock, "release", lambda self: held.append(_held_by(store)) or real(self))
    with pytest.raises(RuntimeError, match="audit: boom"):
        jobs_main.main(["run"], env=ENV)
    assert held == [runlock.lease_id(ENV)] and not store.path(LOCK).exists()


def test_the_lock_is_taken_whatever_the_steps(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    ran = _steps(monkeypatch, store)
    me = runlock.lease_id(ENV)
    for steps in ("access,refresh", "process", "publish", "collect,process"):
        ran.clear()
        assert jobs_main.main(["run", "--steps", steps], env=ENV) == 0
        assert ran and all(lease == me for _, lease in ran)
        assert not store.path(LOCK).exists()


def test_refresh_only_and_migrate_take_no_lock(monkeypatch):
    monkeypatch.setattr(jobs_main.runlock, "take", lambda *a, **k: pytest.fail("took the run lock"))
    monkeypatch.setattr(jobs_main, "open_store", lambda *a: pytest.fail("opened the store"))
    ran = []
    monkeypatch.setattr(jobs_main, "refresh_step", lambda s, **kw: ran.append("refresh"))
    monkeypatch.setattr(jobs_main, "migrate_step", lambda s: ran.append("migrate"))
    assert jobs_main.main(["run", "--steps", "refresh"], env=ENV) == 0
    assert jobs_main.main(["migrate"], env=ENV) == 0
    assert ran == ["refresh", "migrate"]


def test_the_process_command_holds_the_lock_too(tmp_path, monkeypatch, caplog):
    seen = []
    monkeypatch.setattr(jobs_main, "process", lambda store, **kw: seen.append(_held_by(store)))
    assert jobs_main.main(["process", "--data-dir", str(tmp_path)], env=ENV) == 0
    assert seen == [runlock.lease_id(ENV)] and not LocalStore(tmp_path).path(LOCK).exists()
    _hold(LocalStore(tmp_path))
    assert jobs_main.main(["process", "--data-dir", str(tmp_path)], env=ENV) == runlock.EXIT_HELD
    assert len(seen) == 1
    assert "Run it again once that run has finished." in _stopped_lines(caplog)[0]


# ---------------------------------------------------------------- a run that finds it held
def test_a_second_run_stops_before_any_step_and_changes_nothing(tmp_path, monkeypatch, caplog):
    store = LocalStore(tmp_path)
    store.write_json(audit_collect.STATE, STOPPED_MID_MERGE)
    before = store.path(audit_collect.STATE).read_bytes()
    _hold(store)
    lock_before = store.path(LOCK).read_bytes()
    ran = _steps(monkeypatch, store)
    assert jobs_main.main(["run"], env=ENV) == 0
    assert ran == []
    assert store.path(audit_collect.STATE).read_bytes() == before
    assert store.path(LOCK).read_bytes() == lock_before
    assert store.list("raw") == sorted([audit_collect.STATE, LOCK])
    [line] = _stopped_lines(caplog)
    assert line == ("run: another run (execution ah-run-1000b, since 2026-10-23T10:00:00+00:00, steps "
                    "collect,process,publish,refresh) is going, so this run stopped before any step and changed "
                    "nothing. That run loads and publishes the history, so nothing is lost.")


def test_a_run_says_when_the_run_going_doesnt_load_the_history(tmp_path, monkeypatch, caplog):
    store = LocalStore(tmp_path)
    _hold(store, holder={"execution": "ah-run-1000c", "steps": ["access", "refresh"]})
    _steps(monkeypatch, store)
    assert jobs_main.main(["run"], env=ENV) == 0
    [line] = _stopped_lines(caplog)
    assert "That run doesn't load the history, and the next scheduled run does, so nothing is lost." in line


def test_a_run_that_cant_tell_who_holds_the_lock_still_says_why_it_stopped(tmp_path, monkeypatch, caplog):
    store = LocalStore(tmp_path)
    _hold(store, holder={})
    _steps(monkeypatch, store)
    assert jobs_main.main(["run"], env=ENV) == 0
    assert _stopped_lines(caplog)[0].startswith("run: another run is going, so this run stopped before any step")


@pytest.mark.parametrize(("argv", "env", "code", "says"), [
    # The schedule's run, and the installer's plain run or first load: the run going loads the history.
    (["run"], {}, 0, None),
    (["run", "--steps", "collect,process,publish,refresh"], {}, 0, None),
    # A reload the installer started: not done, so it mustn't look done.
    (["run"], {"VALUELENS_AUDIT_BACKFILL_DAYS": "90"}, runlock.EXIT_HELD,
     'This run\'s 90-day history reload didn\'t start: start it again with the installer\'s "run --backfill-days 90" '
     'once that run has finished.'),
    # The installer's org-scoped access.
    (["run", "--steps", "access,refresh"], {}, runlock.EXIT_HELD,
     'Org-scoped access wasn\'t applied: apply it again with the installer\'s "access" once that run has finished, '
     'or the next scheduled run does.'),
    # Steps someone chose.
    (["run", "--steps", "process,publish"], {}, runlock.EXIT_HELD, "Run it again once that run has finished."),
])
def test_a_run_with_a_request_of_its_own_doesnt_report_success_when_it_stopped(tmp_path, monkeypatch, caplog, argv,
                                                                              env, code, says):
    store = LocalStore(tmp_path)
    holder = _hold(store)
    ran = _steps(monkeypatch, store)
    env = dict(ENV, **env)
    assert jobs_main.main(argv, env=env) == code
    assert ran == []
    [line] = _stopped_lines(caplog)
    assert line.endswith(says or "so nothing is lost.")
    if code:
        # A non-zero exit has Container Apps retry the replica once: while the other run is going, the retry stops
        # the same way, and once it has finished, the retry does what was asked.
        assert jobs_main.main(argv, env=env) == code and ran == []
        holder.release()
        assert jobs_main.main(argv, env=env) == 0 and ran


# ---------------------------------------------------------------- live, lapsed and retried
def test_a_live_lock_isnt_taken_over_and_a_lapsed_one_is(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    ran = _steps(monkeypatch, store)
    _hold(store, seconds=60)
    assert jobs_main.main(["run"], env=ENV) == 0 and ran == []
    # A run that was stopped (its replica timed out, or ran out of memory) stops renewing: its lease lapses.
    record = json.loads(store.path(LOCK).read_text(encoding="utf-8"))
    store.path(LOCK).write_text(json.dumps(dict(record, expires=time.time() - 1)), encoding="utf-8")
    assert jobs_main.main(["run"], env=ENV) == 0
    assert [step for step, _ in ran] == ["collect", "process", "publish", "refresh"]
    assert not store.path(LOCK).exists()


def test_a_retry_replica_takes_its_own_executions_lock_back(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    # The first replica ran out of memory while it held the lock, so it never released it.
    _hold(store, lease=runlock.lease_id(ENV), holder=runlock.holder(ENV, jobs_main.Settings.from_env(ENV), ["collect"]))
    ran = _steps(monkeypatch, store)
    assert jobs_main.main(["run"], env=ENV) == 0
    assert len(ran) == 4
    # Another execution still stops.
    ran.clear()
    _hold(store, lease=runlock.lease_id(ENV))
    assert jobs_main.main(["run"], env=dict(ENV, CONTAINER_APP_JOB_EXECUTION_NAME="ah-run-0300b")) == 0
    assert ran == []


def test_every_replica_of_an_execution_has_the_same_lease_id():
    me = runlock.lease_id(JOB)
    assert uuid.UUID(me) and me == runlock.lease_id(dict(JOB))
    assert me != runlock.lease_id(dict(JOB, CONTAINER_APP_JOB_EXECUTION_NAME="ah-run-0300b"))
    assert me != runlock.lease_id(dict(JOB, CONTAINER_APP_JOB_NAME="other-run"))
    # A run outside Container Apps gets its own.
    assert runlock.lease_id({}) != runlock.lease_id({})


def test_local_leases(tmp_path):
    store = LocalStore(tmp_path)
    mine = store.acquire_lease(LOCK, "a", 60, {"steps": ["collect"]})
    with pytest.raises(LeaseHeld) as held:
        store.acquire_lease(LOCK, "b", 60)
    assert held.value.rel == LOCK and held.value.holder == {"steps": ["collect"]}
    # The same ID takes it back, and a renewal moves the expiry on.
    store.acquire_lease(LOCK, "a", 60)
    p = store.path(LOCK)
    p.write_text(json.dumps(dict(json.loads(p.read_text(encoding="utf-8")), expires=time.time() + 5)), encoding="utf-8")
    mine.renew()
    assert json.loads(p.read_text(encoding="utf-8"))["expires"] > time.time() + 30
    mine.release()
    assert not p.exists()
    theirs = store.acquire_lease(LOCK, "b", 60)
    with pytest.raises(RuntimeError, match="lost"):
        mine.renew()
    mine.release()  # someone else's: left alone
    assert p.exists()
    theirs.release()
    # A record that can't be read counts as held until the lease's length after it last changed.
    p.write_text("{", encoding="utf-8")
    with pytest.raises(LeaseHeld):
        store.acquire_lease(LOCK, "a", 60)
    os.utime(p, (time.time() - 61, time.time() - 61))
    store.acquire_lease(LOCK, "a", 60).release()
    assert not p.exists() and not list(p.parent.glob("*.tmp"))


# ---------------------------------------------------------------- the lock can't be checked
class _BrokenStore(LocalStore):
    def acquire_lease(self, *a, **k):
        raise OSError("storage unreachable")


def test_a_storage_error_goes_ahead_with_a_warning(tmp_path, monkeypatch, caplog):
    store = _BrokenStore(tmp_path)
    ran = _steps(monkeypatch, store)
    assert jobs_main.main(["run"], env=ENV) == 0
    assert [step for step, _ in ran] == ["collect", "process", "publish", "refresh"]
    assert ("run: couldn't check whether another run is going (OSError: storage unreachable), so this run goes ahead "
            "without the run lock") in [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]


# ---------------------------------------------------------------- the renewal
def test_the_lock_is_renewed_until_its_released():
    renewals, enough = [], threading.Event()

    class Lease:
        def renew(self):
            renewals.append("renew")
            if len(renewals) >= 3:
                enough.set()

        def release(self):
            renewals.append("release")

    lock = runlock.RunLock(None, Lease(), "me", {}, every=0.01)
    assert enough.wait(10)
    lock.release()
    count = len(renewals)
    time.sleep(0.05)
    assert renewals[-1] == "release" and len(renewals) == count


def test_a_failed_renewal_leases_the_lock_again():
    renewed = threading.Event()

    class Lost:
        def renew(self):
            raise StorageError(409, "LeaseIdMismatchWithLeaseOperation")

        def release(self):
            pytest.fail("released the lost lease")

    class Again:
        released = False

        def renew(self):
            renewed.set()

        def release(self):
            Again.released = True

    taken = []
    store = SimpleNamespace(acquire_lease=lambda rel, lid, seconds, holder: taken.append((rel, lid, holder)) or Again())
    lock = runlock.RunLock(store, Lost(), "me", {"steps": ["collect"]}, every=0.01)
    assert renewed.wait(10)
    lock.release()
    assert taken[0] == (LOCK, "me", {"steps": ["collect"]}) and Again.released


def test_a_lock_another_run_took_is_reported_once(caplog):
    results = [LeaseHeld(LOCK, {"execution": "ah-run-1000b"}), LeaseHeld(LOCK, {}), OSError("down"), "again"]

    def acquire_lease(rel, lid, seconds, holder):
        result = results.pop(0)
        if isinstance(result, Exception):
            raise result
        return SimpleNamespace(renew=lambda: None, release=lambda: None, name=result)

    lock = runlock.RunLock(SimpleNamespace(acquire_lease=acquire_lease), None, "me", {}, every=3600)
    try:
        trouble = None
        for _ in range(3):
            trouble = lock._take_back(RuntimeError("renewal failed"), trouble)
            assert trouble == "held"
        errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
        assert errors == ["run: another run (execution ah-run-1000b) took the run lock while this run was going, so "
                          "the two may overlap; this run carries on"]
        assert lock._take_back(RuntimeError("renewal failed"), trouble) is None and lock._lease.name == "again"
    finally:
        lock.release()


def test_a_release_that_fails_only_warns(caplog):
    class Lease:
        def renew(self):
            pass

        def release(self):
            raise StorageError(500, "InternalError")

    runlock.RunLock(None, Lease(), "me", {}, every=3600).release()
    assert [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING] == [
        "run: couldn't release the run lock (StorageError InternalError: InternalError); it lapses by itself within "
        "60 s"]


# ---------------------------------------------------------------- AdlsStore, with a fake blob client
class Code(str, Enum):
    """Like the SDK's StorageErrorCode: a str Enum, which equals its value but doesn't hash like it."""
    BLOB_NOT_FOUND = "BlobNotFound"
    BLOB_ALREADY_EXISTS = "BlobAlreadyExists"
    LEASE_ALREADY_PRESENT = "LeaseAlreadyPresent"
    LEASE_ID_MISSING = "LeaseIdMissing"
    LEASE_ID_MISMATCH = "LeaseIdMismatchWithLeaseOperation"


class StorageError(Exception):
    """Like the SDK's HttpResponseError: the status, the error code, and the whole response in its text."""

    def __init__(self, status, code):
        super().__init__(f"{getattr(code, 'value', code)}\nRequestId:0\nTime:2026-10-23T03:00:00Z\nErrorCode:{code}")
        self.status_code, self.error_code = status, code


class FakeBlob:
    """One blob with Lease Blob's rules: a lease lasts its duration unless renewed, the same ID can acquire it
    again, another can't until it's released or lapses, and writing a leased blob needs its ID."""

    def __init__(self, service, container, name):
        self.service, self.container, self.name = service, container, name
        self.data, self.lease, self.expires = None, None, 0.0

    def leased(self):
        return self.lease is not None and self.expires > self.service.now

    def acquire_lease(self, lease_duration=-1, lease_id=None):
        self.service.calls.append(("acquire", lease_id))
        if self.service.fail is not None:
            raise self.service.fail
        if self.data is None:
            raise StorageError(404, Code.BLOB_NOT_FOUND)
        if self.leased() and self.lease != lease_id:
            raise StorageError(409, Code.LEASE_ALREADY_PRESENT)
        assert 15 <= lease_duration <= 60
        self.lease, self.expires = lease_id, self.service.now + lease_duration
        return FakeLease(self, lease_id, lease_duration)

    def upload_blob(self, data, overwrite=False, lease=None):
        lease = getattr(lease, "id", lease)
        self.service.calls.append(("upload", lease))
        if self.data is not None and not overwrite:
            raise StorageError(409, Code.BLOB_ALREADY_EXISTS)
        if self.leased() and lease != self.lease:
            raise StorageError(412, Code.LEASE_ID_MISSING)
        self.data = data if isinstance(data, bytes) else data.read()

    def download_blob(self):
        if self.data is None:
            raise StorageError(404, Code.BLOB_NOT_FOUND)
        return SimpleNamespace(readall=lambda: self.data, readinto=lambda fh: fh.write(self.data))


class FakeLease:
    def __init__(self, blob, lease_id, duration):
        self.blob, self.id, self.duration = blob, lease_id, duration

    def renew(self):
        # It renews a lapsed lease too, unless another lease has taken the blob since.
        if self.blob.lease != self.id:
            raise StorageError(409, Code.LEASE_ID_MISMATCH)
        self.blob.expires = self.blob.service.now + self.duration

    def release(self):
        if self.blob.lease != self.id:
            raise StorageError(409, Code.LEASE_ID_MISMATCH)
        self.blob.service.calls.append(("release", self.id))
        self.blob.lease = None


class FakeContainer:
    def __init__(self, service, name):
        self.service, self.name = service, name

    def get_blob_client(self, name):
        return self.service.blob(self.name, name)

    def list_blobs(self, name_starts_with="", include=None):
        return [SimpleNamespace(name=b.name, metadata={}, last_modified=None)
                for (container, _), b in sorted(self.service.blobs.items())
                if container == self.name and b.data is not None and b.name.startswith(name_starts_with)]

    def download_blob(self, name):
        return self.service.blob(self.name, name).download_blob()

    def upload_blob(self, name, data, overwrite=False):
        self.service.blob(self.name, name).upload_blob(data, overwrite=overwrite)


class FakeService:
    def __init__(self):
        self.now, self.blobs, self.calls, self.fail = 0.0, {}, [], None

    def blob(self, container, name):
        return self.blobs.setdefault((container, name), FakeBlob(self, container, name))

    def get_container_client(self, name):
        return FakeContainer(self, name)

    def lock(self):
        return self.blob("raw", "_state/run.lock")


def _adls(tmp_path):
    service = FakeService()
    return AdlsStore("acct", root=tmp_path / "adls", service=service), service


def test_adls_creates_the_lock_blob_then_leases_it_and_records_the_holder(tmp_path):
    store, service = _adls(tmp_path)
    lease = store.acquire_lease(LOCK, "a", 60, {"execution": "ah-run-0300a"})
    blob = service.lock()
    assert service.calls == [("acquire", "a"), ("upload", None), ("acquire", "a"), ("upload", "a")]
    assert blob.lease == "a" and json.loads(blob.data) == {"execution": "ah-run-0300a"}
    lease.release()
    assert blob.lease is None
    # The blob stays, so the next run only leases it.
    service.calls.clear()
    store.acquire_lease(LOCK, "b", 60, {"execution": "ah-run-0300b"})
    assert service.calls == [("acquire", "b"), ("upload", "b")]


def test_adls_a_held_lock_says_who_holds_it(tmp_path):
    store, service = _adls(tmp_path)
    store.acquire_lease(LOCK, "a", 60, OTHER)
    with pytest.raises(LeaseHeld) as held:
        store.acquire_lease(LOCK, "b", 60, {"execution": "ah-run-0300b"})
    assert held.value.holder == OTHER
    # Nothing was written.
    assert json.loads(service.lock().data) == OTHER and ("upload", "b") not in service.calls


def test_adls_a_retry_takes_its_own_lease_back_and_a_lapsed_lease_is_taken_over(tmp_path):
    store, service = _adls(tmp_path)
    store.acquire_lease(LOCK, "a", 60, OTHER)
    store.acquire_lease(LOCK, "a", 60, OTHER)
    service.now += 59
    with pytest.raises(LeaseHeld):
        store.acquire_lease(LOCK, "b", 60)
    service.now += 2
    store.acquire_lease(LOCK, "b", 60, {"execution": "ah-run-0300b"})
    assert service.lock().lease == "b"


def test_adls_a_blob_another_run_created_meanwhile(tmp_path):
    store, service = _adls(tmp_path)
    blob = service.lock()
    real = blob.acquire_lease
    created = []

    def first_finds_it_missing(lease_duration=-1, lease_id=None):
        if not created:
            created.append(True)
            # Another run creates and leases it between this one's lease and its create.
            blob.data, blob.lease, blob.expires = json.dumps(OTHER).encode(), "other", service.now + 60
            raise StorageError(404, Code.BLOB_NOT_FOUND)
        return real(lease_duration=lease_duration, lease_id=lease_id)

    blob.acquire_lease = first_finds_it_missing
    with pytest.raises(LeaseHeld) as held:
        store.acquire_lease(LOCK, "a", 60)
    assert held.value.holder == OTHER and json.loads(blob.data) == OTHER


@pytest.mark.parametrize("error", [StorageError(403, "AuthorizationPermissionMismatch"),
                                   StorageError(404, "ContainerNotFound"), StorageError(503, None)])
def test_adls_other_errors_are_raised(tmp_path, error):
    store, service = _adls(tmp_path)
    service.fail = error
    with pytest.raises(StorageError):
        store.acquire_lease(LOCK, "a", 60)


def test_adls_codes_as_plain_strings_or_only_a_status(tmp_path):
    store, service = _adls(tmp_path)
    store.acquire_lease(LOCK, "a", 60, OTHER)
    for error in (StorageError(409, "LeaseAlreadyPresent"), StorageError(409, None)):
        service.fail = error
        with pytest.raises(LeaseHeld):
            store.acquire_lease(LOCK, "b", 60)


def test_adls_a_holder_that_cant_be_recorded_only_warns(tmp_path, caplog):
    store, service = _adls(tmp_path)
    blob = service.lock()
    blob.upload_blob(b"")

    def fails(data, overwrite=False, lease=None):
        raise StorageError(500, "InternalError")

    blob.upload_blob = fails
    lease = store.acquire_lease(LOCK, "a", 60, OTHER)
    assert blob.lease == "a" and lease.id == "a"
    assert any("couldn't record the lease's holder" in r.getMessage() for r in caplog.records)


def test_a_run_on_adls_holds_the_blob_lease_and_a_second_run_stops(tmp_path, monkeypatch, caplog):
    store, service = _adls(tmp_path)
    ran = []

    def collect(st, settings, budget=None):
        blob = service.lock()
        ran.append((blob.lease, json.loads(blob.data)))
        return {}

    monkeypatch.setattr(jobs_main, "open_store", lambda data_dir, s: store)
    monkeypatch.setattr(jobs_main, "collect", collect)
    assert jobs_main.main(["run", "--steps", "collect"], env=ENV) == 0
    [(lease, holder)] = ran
    assert lease == runlock.lease_id(ENV)
    assert {k: holder[k] for k in ("execution", "job", "steps")} == {
        "execution": "ah-run-0300a", "job": "ah-run", "steps": ["collect"]}
    assert service.lock().lease is None and ("release", lease) in service.calls

    # Another run's live lease stops this one; once it lapses, the next run goes ahead.
    service.lock().acquire_lease(60, "other")
    service.lock().upload_blob(json.dumps(OTHER).encode(), overwrite=True, lease="other")
    env = dict(ENV, CONTAINER_APP_JOB_EXECUTION_NAME="ah-run-0300b")
    assert jobs_main.main(["run", "--steps", "collect"], env=env) == 0 and len(ran) == 1
    assert "execution ah-run-1000b" in _stopped_lines(caplog)[0]
    service.now += 61
    assert jobs_main.main(["run", "--steps", "collect"], env=env) == 0 and len(ran) == 2


def test_a_run_on_adls_goes_ahead_when_the_lock_cant_be_checked(tmp_path, monkeypatch, caplog):
    store, service = _adls(tmp_path)
    service.fail = StorageError(403, "AuthorizationPermissionMismatch")
    ran = []
    monkeypatch.setattr(jobs_main, "open_store", lambda data_dir, s: store)
    monkeypatch.setattr(jobs_main, "collect", lambda *a, **k: ran.append("collect") or {})
    assert jobs_main.main(["run", "--steps", "collect"], env=ENV) == 0 and ran == ["collect"]
    [warning] = [r.getMessage() for r in caplog.records if r.name == "valuelens_jobs.runlock"]
    assert warning == ("run: couldn't check whether another run is going (StorageError "
                       "AuthorizationPermissionMismatch: AuthorizationPermissionMismatch), so this run goes ahead "
                       "without the run lock")
