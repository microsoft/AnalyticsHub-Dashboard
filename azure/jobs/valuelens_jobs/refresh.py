"""Refresh the Power BI semantic models. Port of the Fabric `ValueLens_Refresh_Model` notebook.

Enhanced refresh (Premium/PPU/Fabric capacity) is tried first so the incremental refresh policy
applies; a Pro workspace rejects it with 400, so the standard refresh is used instead and its
outcome is read from the refresh history.

A run with a deadline stops waiting at it: a refresh still running carries on in Power BI, and the
run doesn't fail for it. A full refresh (older days were republished) stays owed, per model, in
REFRESH_STATE until a run sees one complete, so the next run does it if this one couldn't.
"""
from __future__ import annotations

import logging
import time
from datetime import timedelta

from .api import POWERBI, DeadlineReached

log = logging.getLogger("valuelens_jobs.refresh")

BASE = "https://api.powerbi.com/v1.0/myorg"
# The full refreshes owed: {"full_refresh_owed": {model: {"refresh_id": id or None, "enhanced": bool or None}}}.
REFRESH_STATE = "raw/_state/refresh.json"
FINAL = {"Completed", "Failed", "Cancelled", "Disabled", "TimedOut"}
ENHANCED = {"type": "full", "commitMode": "transactional", "applyRefreshPolicy": True, "retryCount": 1}
# Reloads every partition, not just the incremental window. Used when older days were republished.
ENHANCED_ALL = {**ENHANCED, "applyRefreshPolicy": False}
STANDARD = {"notifyOption": "NoNotification"}
# The template's incremental refresh policy reloads the 7 days before today (offset -1).
INCREMENTAL_DAYS = 7
# Tables whose policy reloads a longer window: the installer's M365 Activity policy reloads 35 days.
INCREMENTAL_DAYS_BY_TABLE = {"m365_activity_daily": 35}
# Models refreshed only while their module is on and has something to read. VALUELENS_SEMANTIC_MODELS also feeds the
# web app, which lists the Agent Evaluator model as soon as it's deployed, and VALUELENS_MODULES follows the module's
# tick; the jobs leave the model alone until the installer lists the environments (VALUELENS_DATAVERSE_ENVIRONMENTS),
# which it does once the managed identity can read one of them.
MODEL_MODULES = {"ae": "agentEvaluator"}


def needs_full_refresh(publish_results, today) -> bool:
    """True when publish rewrote or removed a day its table's incremental refresh window won't reload."""
    def outside(r):
        days = INCREMENTAL_DAYS_BY_TABLE.get(r.get("table"), INCREMENTAL_DAYS)
        return r["oldest_day"] < (today - timedelta(days=days)).isoformat()

    return any(outside(r) for r in publish_results or [] if r.get("oldest_day"))


class Refresher:
    def __init__(self, api, *, sleep=time.sleep, clock=time.monotonic, busy_minutes=30, timeout_minutes=120,
                 poll_seconds=30, deadline=None):
        self.api, self.sleep, self.clock = api, sleep, clock
        self.busy_minutes, self.timeout_minutes, self.poll_seconds = busy_minutes, timeout_minutes, poll_seconds
        # A `clock` reading, or None: no wait runs past it (DeadlineReached instead).
        self.deadline = deadline

    def _url(self, ws, ds):
        return f"{BASE}/groups/{ws}/datasets/{ds}/refreshes"

    def _past(self, wait) -> bool:
        return self.deadline is not None and self.clock() + wait >= self.deadline

    def start(self, url, body):
        """Returns (refresh id or request id, enhanced?). Waits while another refresh is running."""
        deadline = self.clock() + self.busy_minutes * 60
        enhanced = body is not STANDARD
        while True:
            r = self.api.post(url, scope=POWERBI, json=body, timeout=60)
            if r.status_code == 202:
                location = (r.headers.get("Location") or "").rstrip("/")
                request_id = r.headers.get("RequestId") or r.headers.get("x-ms-request-id")
                return (location.split("/")[-1] if enhanced and location else request_id), enhanced
            text = (r.text or "").lower()
            busy = r.status_code in (409, 429) or "in progress" in text
            if busy and self.clock() < deadline:
                if self._past(60):
                    raise DeadlineReached("another refresh of the model was still running at the run's time limit")
                log.info("refresh: another refresh is running (%s); trying again in a minute", r.status_code)
                self.sleep(60)
                continue
            if enhanced and r.status_code in (400, 403):
                log.info("refresh: enhanced refresh not available (%s); using a standard refresh", r.status_code)
                body, enhanced = STANDARD, False
                continue
            raise RuntimeError(f"Power BI would not start the refresh ({r.status_code}): {(r.text or '')[:1000]}")

    def _status(self, url, refresh_id, enhanced):
        if enhanced:
            r = self.api.get(f"{url}/{refresh_id}", scope=POWERBI, timeout=60)
            # The enhanced refresh details endpoint answers 202 while the refresh is still in progress.
            if r.status_code in (200, 202):
                d = r.json()
                return d.get("extendedStatus") or d.get("status"), d
        else:
            r = self.api.get(url, scope=POWERBI, params={"$top": 10}, timeout=60)
            if r.status_code == 200:
                history = r.json().get("value", [])
                match = next((h for h in history if refresh_id and h.get("requestId") == refresh_id), None)
                match = match or (history[0] if history else None)
                if match:
                    status = match.get("status")
                    return ("Running" if status == "Unknown" else status), match
                return None, {}
        if r.status_code not in (404, 429, 500, 502, 503, 504):
            raise RuntimeError(f"Reading refresh status failed ({r.status_code}): {(r.text or '')[:500]}")
        return None, {}

    def wait(self, url, refresh_id, enhanced):
        deadline = self.clock() + self.timeout_minutes * 60
        while True:
            status, detail = self._status(url, refresh_id, enhanced)
            if status in FINAL:
                if status != "Completed":
                    error = detail.get("serviceExceptionJson") or "; ".join(
                        str(m.get("message", m)) for m in detail.get("messages", []) or [])
                    raise RuntimeError(f"The refresh ended as {status}. {error}".strip())
                return detail
            if self.clock() > deadline:
                raise TimeoutError(f"The refresh was still running after {self.timeout_minutes} minutes.")
            if self._past(self.poll_seconds):
                raise DeadlineReached("the refresh was still running at the run's time limit")
            self.sleep(self.poll_seconds)

    def completed(self, url, refresh_id, enhanced) -> bool:
        """Whether an earlier refresh is known to have completed. False when Power BI no longer lists it."""
        try:
            if enhanced:
                r = self.api.get(f"{url}/{refresh_id}", scope=POWERBI, timeout=60)
                if r.status_code in (200, 202):
                    d = r.json()
                    return (d.get("extendedStatus") or d.get("status")) == "Completed"
                return False
            r = self.api.get(url, scope=POWERBI, params={"$top": 60}, timeout=60)
            return r.status_code == 200 and any(
                h.get("requestId") == refresh_id and h.get("status") == "Completed" for h in r.json().get("value", []))
        except DeadlineReached:
            raise
        except Exception as exc:
            log.info("refresh: couldn't read how refresh %s ended (%s)", refresh_id, exc)
            return False

    def refresh(self, workspace_id, dataset_id, *, all_partitions=False, on_start=None):
        url = self._url(workspace_id, dataset_id)
        refresh_id, enhanced = self.start(url, ENHANCED_ALL if all_partitions else ENHANCED)
        log.info("refresh: started %s (%s%s)", refresh_id, "enhanced" if enhanced else "standard",
                 ", all partitions" if enhanced and all_partitions else "")
        if on_start is not None:
            on_start(refresh_id, enhanced)
        return self.wait(url, refresh_id, enhanced)


def _targets(settings, models):
    """The models this run refreshes, in order: (name, its reference)."""
    out = []
    for name, ref in models.items():
        module = MODEL_MODULES.get(name)
        if module and not settings.has(module):
            log.info("refresh: %s skipped; %s isn't in VALUELENS_MODULES, so nothing loads into it", name, module)
            continue
        if module == "agentEvaluator" and not settings.dataverse_environments:
            log.info("refresh: %s skipped; VALUELENS_DATAVERSE_ENVIRONMENTS lists no environment yet, so nothing loads into it", name)
            continue
        out.append((name, ref))
    return out


class _Owed:
    """The full refreshes owed, per model, kept in REFRESH_STATE. Without a store nothing is carried over."""

    def __init__(self, store, models):
        self.store, self.models, self.dirty = store, {}, False
        if store is None:
            return
        try:
            saved = (store.read_json(REFRESH_STATE, {}) or {}).get("full_refresh_owed") or {}
        except Exception as exc:
            log.warning("refresh: couldn't read %s (%s); no full refresh is carried over from earlier runs",
                        REFRESH_STATE, exc)
            saved = {}
        # A model no longer configured owes nothing.
        self.models = {name: dict(entry or {}) for name, entry in saved.items() if name in models}
        self.dirty = len(self.models) != len(saved)

    def save(self):
        if self.store is None:
            return
        try:
            self.store.write_json(REFRESH_STATE, {"full_refresh_owed": self.models})
        except Exception as exc:
            log.warning("refresh: couldn't write %s (%s); the next run may not know a full refresh is owed",
                        REFRESH_STATE, exc)


def refresh_models(api, settings, *, all_partitions=False, store=None, deadline=None, **kwargs) -> list[str]:
    """Refresh the configured models one at a time. Returns the names refreshed.

    `deadline` (a `clock` reading) caps every wait, the API's retry waits included: past it no refresh starts,
    and one still running carries on in Power BI while the run ends without failing for it. With `store`, a full
    refresh (`all_partitions`) is recorded as owed for every model before any starts, and cleared once one is
    seen to complete; a later run with the store does the owed one, unless it sees the one left running completed.
    """
    models = settings.semantic_models or {}
    if not models:
        log.warning("refresh: no semantic models configured (VALUELENS_SEMANTIC_MODELS); skipped")
        return []
    r = Refresher(api, deadline=deadline, **kwargs)
    targets = _targets(settings, models)
    owed = _Owed(store, models)
    if store is not None and all_partitions:
        for name, _ in targets:
            owed.models[name] = {"refresh_id": None, "enhanced": None}
    if store is not None and (all_partitions or owed.dirty):
        owed.save()
    swap = deadline is not None and hasattr(api, "deadline")
    if swap:
        before = (api.deadline, api.clock)
        api.deadline, api.clock = deadline, r.clock
    done = []
    try:
        for i, (name, ref) in enumerate(targets):
            ws = (ref or {}).get("workspaceId") or settings.powerbi_workspace_id
            ds = (ref or {}).get("itemId") or (ref or {}).get("datasetId")
            if not ws or not ds:
                raise ValueError(f"Semantic model {name!r} needs workspaceId and itemId.")
            started = []

            def on_start(refresh_id, enhanced, _name=name):
                started.append(refresh_id)
                if _name in owed.models:
                    owed.models[_name] = {"refresh_id": refresh_id, "enhanced": enhanced}
                    owed.save()

            try:
                entry = owed.models.get(name)
                if entry is not None and not all_partitions and entry.get("refresh_id") and r.completed(
                        r._url(ws, ds), entry["refresh_id"], entry.get("enhanced")):
                    log.info("refresh: %s: the full refresh an earlier run left running has completed", name)
                    owed.models.pop(name)
                    owed.save()
                full = all_partitions or name in owed.models
                log.info("refresh: %s%s", name, " (a full refresh is owed from an earlier run)"
                         if full and not all_partitions else "")
                r.refresh(ws, ds, all_partitions=full, on_start=on_start)
            except DeadlineReached as exc:
                if started:
                    log.warning("refresh: %s is still running at the run's time limit; it carries on in Power BI%s",
                                name, "; the full refresh stays owed until a run sees it complete"
                                if name in owed.models else "")
                else:
                    log.warning("refresh: %s didn't start before the run's time limit (%s); the next run "
                                "refreshes it", name, exc)
                rest = [n for n, _ in targets[i + 1:]]
                if rest:
                    log.warning("refresh: not started before the run's time limit, so the next run refreshes "
                                "them: %s", ", ".join(rest))
                break
            if name in owed.models:
                owed.models.pop(name)
                owed.save()
            done.append(name)
    finally:
        if swap:
            api.deadline, api.clock = before
    return done
