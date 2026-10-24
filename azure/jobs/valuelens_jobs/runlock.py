"""The run lock: one run of the run job at a time.

The daily schedule can start a run while another is still going, for example beside a long first load. So can a
run started by hand, by the installer when it couldn't check, or by a run that starts the next one (see
continue_run). Two runs at once share the audit staging area and the tenant's audit queries, and both read, change
and write the state in raw/_state, so one can undo the other's progress. So a run that opens the store leases
raw/_state/run.lock for the whole run, and a run that finds it leased stops before any step.

The lease lasts LEASE_SEC and a thread renews it every RENEW_EVERY_SEC, so the lock of a run that was stopped (at
its replica timeout, or out of memory) lapses by itself within LEASE_SEC. Its ID comes from the job execution's
name, so a retry replica of the same execution takes its own lock back. When the lock can't be checked at all (a
storage error), the run goes ahead without it and warns: the lock never stops the job from running.
"""
from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime, timezone

from .storage import LeaseHeld

log = logging.getLogger("valuelens_jobs.runlock")
LOCK = "raw/_state/run.lock"
# A blob lease lasts 15 to 60 seconds, or until it's released, which a stopped run never does.
LEASE_SEC = 60
RENEW_EVERY_SEC = 15
# The exit code of a run that stopped because another was going, when that leaves a request of its own undone
# (EX_TEMPFAIL): a reload, org-scoped access or chosen steps. Container Apps retries the replica once.
EXIT_HELD = 75
_IDS = uuid.uuid5(uuid.NAMESPACE_URL, "valuelens-jobs:run-lock")


def lease_id(environ) -> str:
    """The same ID for every replica of a job execution, so a retry replica takes its own lock back. Container Apps
    names the execution in CONTAINER_APP_JOB_EXECUTION_NAME; any other run gets an ID of its own."""
    execution = (environ.get("CONTAINER_APP_JOB_EXECUTION_NAME") or "").strip()
    if not execution:
        return str(uuid.uuid4())
    return str(uuid.uuid5(_IDS, f"{(environ.get('CONTAINER_APP_JOB_NAME') or '').strip()}/{execution}"))


def holder(environ, settings, steps) -> dict:
    """What a run records about itself in the lock, so a run that finds it held can say which run is going."""
    record = {
        "execution": environ.get("CONTAINER_APP_JOB_EXECUTION_NAME"),
        "job": environ.get("CONTAINER_APP_JOB_NAME"),
        "since": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "steps": list(steps),
        "backfill_days": settings.audit_backfill_days,
        "version": settings.version,
    }
    return {k: v for k, v in record.items() if v}


def take(store, environ, settings, steps):
    """Takes the run lock for this run, and keeps it until `RunLock.release`. Raises LeaseHeld when another run
    holds it. When it can't be checked, it warns and returns None, and the run goes ahead without it."""
    lid, record = lease_id(environ), holder(environ, settings, steps)
    try:
        lease = store.acquire_lease(LOCK, lid, LEASE_SEC, record)
    except LeaseHeld:
        raise
    except Exception as exc:
        log.warning("run: couldn't check whether another run is going (%s), so this run goes ahead without the run "
                    "lock", _brief(exc))
        return None
    log.info("run: holding the run lock (%s) until this run ends", LOCK)
    return RunLock(store, lease, lid, record)


class RunLock:
    """The run lock this run holds. A thread renews it until `release`."""

    def __init__(self, store, lease, lid, record, every=RENEW_EVERY_SEC):
        self._store, self._lease, self._id, self._record, self._every = store, lease, lid, record, every
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._keep, name="run-lock", daemon=True)
        self._thread.start()

    def _keep(self):
        trouble = None  # what has gone wrong since the lease was last renewed, so each is logged once
        while not self._stop.wait(self._every):
            try:
                self._lease.renew()
            except Exception as exc:
                if self._stop.is_set():
                    return
                trouble = self._take_back(exc, trouble)
            else:
                if trouble:
                    log.info("run: renewed the run lock again")
                trouble = None

    def _take_back(self, failed, trouble):
        """After a failed renewal, leases the lock again with this run's ID: that works unless another run has it."""
        try:
            self._lease = self._store.acquire_lease(LOCK, self._id, LEASE_SEC, self._record)
        except LeaseHeld as held:
            if trouble != "held":
                log.error("run: %s took the run lock while this run was going, so the two may overlap; this run "
                          "carries on", _who(held.holder))
            return "held"
        except Exception as exc:
            if trouble is None:
                log.warning("run: couldn't renew the run lock (%s); trying again every %s s. If it lapses, another "
                            "run can start beside this one", _brief(exc), self._every)
            return trouble or "failing"
        log.info("run: leased the run lock again after a renewal failed (%s)", _brief(failed))
        return None

    def release(self) -> bool:
        """Stops renewing and releases the lock, so the next run can take it straight away. If the release fails,
        the lock lapses by itself within LEASE_SEC. True when it was released."""
        self._stop.set()
        self._thread.join(LEASE_SEC)
        try:
            self._lease.release()
        except Exception as exc:
            log.warning("run: couldn't release the run lock (%s); it lapses by itself within %s s", _brief(exc),
                        LEASE_SEC)
            return False
        log.info("run: released the run lock")
        return True


def stopped(held: LeaseHeld, steps, settings) -> int:
    """Says in one line why this run stopped, and returns its exit code. A run that collects, as the schedule's do,
    exits 0, so a long load doesn't leave a failed execution every day. A reload, or a run of chosen steps without
    collect (the installer's org-scoped access), exits EXIT_HELD, so nobody takes it as done."""
    theirs = held.holder.get("steps")
    line = [f"run: {_who(held.holder)} is going, so this run stopped before any step and changed nothing."]
    if not isinstance(theirs, list) or "collect" in theirs:
        line.append("That run loads and publishes the history, so nothing is lost.")
    else:
        line.append("That run doesn't load the history, and the next scheduled run does, so nothing is lost.")
    days = settings.audit_backfill_days
    if days:
        line.append(f"This run's {days}-day history reload didn't start: start it again with the installer's "
                    f"\"run --backfill-days {days}\" once that run has finished.")
    elif "collect" not in steps and "access" in steps and "publish" not in steps:
        line.append("Org-scoped access wasn't applied: apply it again with the installer's \"access\" once that run "
                    "has finished, or the next scheduled run does.")
    elif "collect" not in steps:
        line.append("Run it again once that run has finished.")
    log.warning(" ".join(line))
    return 0 if "collect" in steps and not days else EXIT_HELD


def _who(record) -> str:
    """'another run (execution …, since …, steps …)', with what the holder recorded."""
    about = [f"execution {record['execution']}"] if record.get("execution") else []
    if record.get("since"):
        about.append(f"since {record['since']}")
    if isinstance(record.get("steps"), list):
        about.append("steps " + ",".join(map(str, record["steps"])))
    return "another run" + (f" ({', '.join(about)})" if about else "")


def _brief(exc) -> str:
    """The error on one line: a storage error's text carries the whole response."""
    code = getattr(exc, "error_code", None)
    code = getattr(code, "value", code)
    first = next((line.strip() for line in str(exc).splitlines() if line.strip()), "")
    return f"{type(exc).__name__}{f' {code}' if code else ''}{f': {first[:200]}' if first else ''}"
