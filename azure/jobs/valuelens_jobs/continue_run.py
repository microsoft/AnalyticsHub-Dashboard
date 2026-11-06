"""A long load carries itself on: a run that paused on its time budget starts the next run straight away.

A run fetches the audit history for up to about 3 hours, publishes what it has loaded and pauses (see run_budget in
__main__). Without this, the next scheduled run carries on. With it, the run starts the next run itself, once it has
released the run lock, until the history is loaded. It starts it only when this run:
- paused on its time budget and loaded at least one window of the history: the trailing look-back's windows, which
  every run fetches again, don't count, so each run gets further back;
- had no errors: a run that exits non-zero starts nothing;
- collected the tenant's data: a run with the collect step, and not a sample run;
- is one of fewer than MAX_A_DAY runs that day (UTC) to start the next one, counted in raw/_state/chain.json.

`decide` records the start while this run still holds the run lock. `start` starts the next run after the release,
so it doesn't stop behind this run's lock; if the release failed, it waits for the lock to lapse first. The next run
can still stop behind another run's lock, one started by hand for example. If that run collects, it carries the
load on and starts its own next run. If it doesn't, the next scheduled run carries on.

The start uses the run job's own system-assigned identity, which holds Container Apps Jobs Operator on this job
only. The installer assigns it, or leaves a pending admin action when it can't. The start sends no body, so the next
run uses the job's own template and arguments, as a scheduled run does. If it fails (the role not assigned yet, a
firewall, Azure busy), it logs one warning and the next scheduled run carries on: the run's exit code doesn't change.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from .api import ARM, Api, TokenSource, raise_for_status

log = logging.getLogger("valuelens_jobs.continue_run")
CHAIN = "raw/_state/chain.json"
# The most runs a day (UTC) that start the next one: a load that needs more waits for the next scheduled run.
MAX_A_DAY = 8
# The run job's resource ID, set by the template. A job deployed before 0.6.9 doesn't have it.
JOB_ID_ENV = "VALUELENS_RUN_JOB_ID"
API_VERSION = "2024-03-01"
# One retry, with short waits: a next run that doesn't start only waits for the next scheduled one.
ATTEMPTS = 2
TIMEOUT = (10, 30)  # connect, read (seconds)


def decide(store, environ, audit, now=None):
    """The run job's resource ID when this run should start the next one, with the start counted in CHAIN; otherwise
    None. Call it while the run holds the run lock, once every step has succeeded. `audit` is what the audit
    collector returned."""
    if not (isinstance(audit, dict) and audit.get("paused")):
        return None
    left = audit.get("windows_left")
    if not audit.get("windows_loaded"):
        log.info("run: this run loaded no window of the history before its time budget, so it doesn't start the "
                 "next run; the next scheduled run carries on (%s windows left)", left)
        return None
    job = (environ.get(JOB_ID_ENV) or "").strip()
    if not job:
        log.info("run: %s isn't set (a job deployed before 0.6.9), so the next scheduled run carries on with the "
                 "history (%s windows left)", JOB_ID_ENV, left)
        return None
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    day = now.date().isoformat()
    try:
        count = _count(store, day)
        if count >= MAX_A_DAY:
            log.info("run: %s runs have started the next one today (UTC), the most a day, so the next scheduled run "
                     "carries on (%s windows left)", count, left)
            return None
        store.write_json(CHAIN, {"day": day, "count": count + 1, "at": now.isoformat(timespec="seconds"),
                                 "execution": environ.get("CONTAINER_APP_JOB_EXECUTION_NAME")})
    except Exception as exc:
        log.warning("run: couldn't count the next run in %s (%s), so this run doesn't start it; the next scheduled "
                    "run carries on", CHAIN, _brief(exc))
        return None
    log.info("run: the history isn't all loaded (%s windows left), so this run starts the next one once it has "
             "released the run lock (%s of %s today, UTC)", left, count + 1, MAX_A_DAY)
    return job


def _count(store, day) -> int:
    """How many runs have started the next one on `day`. A file that doesn't hold a count is taken as none, and
    written again."""
    try:
        chain = store.read_json(CHAIN, None)
    except ValueError:  # not JSON
        chain = None
    if not isinstance(chain, dict) or chain.get("day") != day:
        return 0
    count = chain.get("count")
    return count if isinstance(count, int) and count >= 0 else 0


def start(job_id, *, wait=0.0, credential=None, session=None, sleep=time.sleep) -> bool:
    """Starts the next run of the run job: a POST to Jobs - Start with no body, as a body overrides the job's
    template. Waits `wait` seconds first. True when Azure took it. Never raises: a failure logs one warning."""
    try:
        if wait:
            log.info("run: waiting %.0f s for the run lock to lapse before starting the next run", wait)
            sleep(wait)
        if credential is None:
            from azure.identity import ManagedIdentityCredential

            # No client ID: the run job's system-assigned identity, the one allowed to start it.
            credential = ManagedIdentityCredential()
        api = Api(TokenSource(credential), session=session, sleep=sleep, attempts=ATTEMPTS)
        url = f"https://management.azure.com{job_id}/start?api-version={API_VERSION}"
        r = raise_for_status(api.request("POST", url, scope=ARM, timeout=TIMEOUT), "start the next run")
    except Exception as exc:
        if getattr(exc, "status_code", None) == 403:
            log.warning("run: couldn't start the next run: the run job's own identity isn't allowed to start it yet "
                        "(HTTP 403), so the next scheduled run carries on. An admin can let it start straight away: "
                        "see the pending admin action in the installer's \"status\"")
        else:
            log.warning("run: couldn't start the next run (%s), so the next scheduled run carries on", _brief(exc))
        return False
    try:
        name = (r.json() or {}).get("name")
    except Exception:  # 202 Accepted has no body
        name = None
    log.info("run: started the next run%s", f" ({name})" if name else "")
    return True


def _brief(exc) -> str:
    """The error on one line."""
    first = next((line.strip() for line in str(exc).splitlines() if line.strip()), "")
    return f"{type(exc).__name__}{f': {first[:200]}' if first else ''}"
