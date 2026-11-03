"""Audit ingester parity: valuelens_core.audit (DuckDB) vs the Fabric notebook (Spark goldens)."""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timedelta, timezone

import pytest

import valuelens_audit_golden as ag
import valuelens_golden as vg
from valuelens_core import audit


def test_duckdb_flatten_matches_spark_golden():
    problems = vg.diff(ag.read_expected(), ag.run_duckdb())
    assert not problems, "\n".join(problems)


def test_helpers_match_notebook_cell6():
    nb = ag.notebook_helpers()
    for record in ag.records():
        assert audit.canonicalize_audit_record(record) == nb["canonicalize_audit_record"](record)
        assert audit.build_source_record_key(record) == nb["build_source_record_key"](record)
    s = datetime(2026, 3, 1, tzinfo=timezone.utc)
    e = datetime(2026, 3, 2, 5, tzinfo=timezone.utc)
    assert audit.stable_window_key(s, e) == nb["stable_window_key"](s, e)
    assert list(audit.KEY_COLUMNS) == list(nb["KEY_COLUMNS"])


def test_build_windows_cover_range_without_gaps():
    s = datetime(2026, 3, 1, tzinfo=timezone.utc)
    e = datetime(2026, 3, 2, 5, tzinfo=timezone.utc)
    windows = audit.build_windows(s, e, 8)
    assert windows[0][0] == s and windows[-1][1] == e
    assert all(a[1] == b[0] for a, b in zip(windows, windows[1:]))


RECOVERY_HELPERS = (
    "split_window", "expand_split_windows", "retry_delay", "AdaptiveLimiter",
    "_manifest_range", "uncovered_failed_ranges", "empty_recheck_windows",
    "pending_recheck_windows",
)
TOKEN_HELPERS = ("token_claims", "audit_token_problems")


def test_recovery_helpers_are_verbatim_in_notebook_cell6():
    import ast
    import inspect

    source = "".join(ag._cells()[ag.HELPER_CELL]["source"])
    nodes = {n.name: n for n in ast.parse(source).body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    for name in RECOVERY_HELPERS:
        assert name in nodes, f"{name} missing from notebook cell 6"
        assert ast.get_source_segment(source, nodes[name]) == inspect.getsource(getattr(audit, name)).rstrip(), name
    assert f"RECHECK_PENDING = {audit.RECHECK_PENDING!r}" in source


def test_token_helpers_are_verbatim_in_notebook_cell4():
    import ast
    import inspect

    source = "".join(ag._cells()[4]["source"])
    nodes = {n.name: n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef)}
    for name in TOKEN_HELPERS:
        assert name in nodes, f"{name} missing from notebook cell 4"
        assert ast.get_source_segment(source, nodes[name]) == inspect.getsource(getattr(audit, name)).rstrip(), name
    assert f"AUDIT_ROLE = {audit.AUDIT_ROLE!r}" in source


def _jwt(claims):
    import base64

    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{body}.sig"


TENANT = "11111111-2222-3333-4444-555555555555"


def test_audit_token_problems():
    good = _jwt({"tid": TENANT, "roles": ["AuditLogsQuery.Read.All", "User.Read.All"]})
    assert audit.audit_token_problems(good, TENANT) == []
    assert audit.audit_token_problems(good, TENANT.upper()) == []
    # A tenant given by domain name can't be compared, so only the role is checked.
    assert audit.audit_token_problems(good, "contoso.onmicrosoft.com") == []
    other = audit.audit_token_problems(_jwt({"tid": "99999999-2222-3333-4444-555555555555",
                                             "roles": ["AuditLogsQuery.Read.All"]}), TENANT)
    assert len(other) == 1 and "not TENANT_ID" in other[0]
    none = audit.audit_token_problems(_jwt({"tid": TENANT, "roles": ["User.Read.All"]}), TENANT)
    assert none == ["the token has no AuditLogsQuery.Read.All application permission"]
    scoped = audit.audit_token_problems(_jwt({"tid": TENANT, "roles": ["AuditLogsQuery-SharePoint.Read.All",
                                                                       "AuditLogsQuery-Exchange.Read.All"]}))
    assert len(scoped) == 1 and "AuditLogsQuery-Exchange.Read.All, AuditLogsQuery-SharePoint.Read.All" in scoped[0]
    assert "not Copilot interactions" in scoped[0]
    # Tokens that can't be decoded are not flagged.
    for token in (None, "", "opaque", "a.!!!.c", _jwt(["not", "a", "dict"])):
        assert audit.audit_token_problems(token, TENANT) == []


def _empty(ws, we, completed=None, **extra):
    entry = {"status": "succeeded", "window_start": ws.isoformat(), "window_end": we.isoformat(), "rows": 0,
             "pages": 0, "files": [], "completed_at": (completed or we + timedelta(hours=1)).isoformat()}
    entry.update(extra)
    return {audit.stable_window_key(ws, we): entry}


def test_empty_recheck_windows():
    now = datetime(2026, 9, 10, tzinfo=timezone.utc)
    cutoff = now - timedelta(days=7)
    h8 = timedelta(hours=8)
    due = datetime(2026, 8, 25, tzinfo=timezone.utc)
    manifest = {}
    manifest.update(_empty(due, due + h8))
    manifest.update(_empty(due - h8, due))
    # Still in the look-back, so the trailing re-query covers it.
    recent = cutoff + timedelta(hours=1)
    manifest.update(_empty(recent, recent + h8))
    # Older than recheck_days.
    old = now - timedelta(days=31)
    manifest.update(_empty(old, old + h8))
    # Fetched again well after it ended: settled.
    settled = datetime(2026, 8, 20, tzinfo=timezone.utc)
    manifest.update(_empty(settled, settled + h8, completed=settled + h8 + timedelta(days=8)))
    # Has records, failed, or not succeeded.
    had = datetime(2026, 8, 21, tzinfo=timezone.utc)
    manifest.update(_empty(had, had + h8, rows=3, pages=1, files=["x"]))
    manifest.update(_empty(had + h8, had + 2 * h8, status="failed"))
    assert audit.empty_recheck_windows(manifest, now, cutoff, 30, 7) == [(due - h8, due), (due, due + h8)]
    assert audit.empty_recheck_windows(manifest, now, cutoff, 0, 7) == []
    # A later fetch of the same hours (here two 4 h halves) supersedes the empty window.
    later = due + h8 + timedelta(days=9)
    manifest.update(_empty(due, due + timedelta(hours=4), completed=later))
    manifest.update(_empty(due + timedelta(hours=4), due + h8, completed=later))
    assert audit.empty_recheck_windows(manifest, now, cutoff, 30, 7) == [(due - h8, due)]


def test_split_window_halves_down_to_minimum():
    s = datetime(2026, 8, 25, tzinfo=timezone.utc)
    halves = audit.split_window(s, s + timedelta(hours=8), 1)
    assert halves == [(s, s + timedelta(hours=4)), (s + timedelta(hours=4), s + timedelta(hours=8))]
    assert audit.split_window(s, s + timedelta(hours=2), 1) == [
        (s, s + timedelta(hours=1)), (s + timedelta(hours=1), s + timedelta(hours=2))]
    assert audit.split_window(s, s + timedelta(hours=1), 1) == []
    assert audit.split_window(s, s + timedelta(hours=3), 2) == []


def test_expand_split_windows_follows_split_parents_recursively():
    s = datetime(2026, 8, 25, tzinfo=timezone.utc)
    key = audit.stable_window_key
    manifest = {
        key(s, s + timedelta(hours=8)): {"status": "split"},
        key(s, s + timedelta(hours=4)): {"status": "split"},
        key(s + timedelta(hours=4), s + timedelta(hours=8)): {"status": "succeeded"},
    }
    leaves = audit.expand_split_windows(manifest, s, s + timedelta(hours=8), 1)
    assert [(b - a).total_seconds() / 3600 for a, b in leaves] == [2, 2, 4]
    assert leaves[0][0] == s and leaves[-1][1] == s + timedelta(hours=8)
    assert len(audit.expand_split_windows(manifest, s, s + timedelta(hours=8), 1, include_parents=True)) == 5
    # Unsplit windows (including every entry in a manifest from before splitting existed) expand to themselves.
    assert audit.expand_split_windows({}, s, s + timedelta(hours=8), 1) == [(s, s + timedelta(hours=8))]


def test_retry_delay_is_exponential_capped_and_jittered():
    assert audit.retry_delay(1, 60, 900, rand=lambda: 1.0) == 60
    assert audit.retry_delay(3, 60, 900, rand=lambda: 1.0) == 240
    assert audit.retry_delay(10, 60, 900, rand=lambda: 1.0) == 900
    assert audit.retry_delay(2, 60, 900, rand=lambda: 0.0) == 60


def test_adaptive_limiter_shrinks_once_per_cooldown_and_never_below_minimum():
    now = [0.0]
    limiter = audit.AdaptiveLimiter(6, minimum=2, cooldown_seconds=60, clock=lambda: now[0])
    assert limiter.shrink("failed") and limiter.limit == 5
    assert not limiter.shrink("failed in the same burst") and limiter.limit == 5
    now[0] = 61
    assert limiter.shrink("429", halve=True) and limiter.limit == 2
    now[0] = 200
    assert not limiter.shrink("failed") and limiter.limit == 2
    assert [h[:2] for h in limiter.history] == [(6, 5), (5, 2)]


def test_adaptive_limiter_caps_concurrent_holders():
    import threading
    import time

    limiter = audit.AdaptiveLimiter(2)
    active, peak, lock = [0], [0], threading.Lock()

    def work():
        with limiter:
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.01)
            with lock:
                active[0] -= 1

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak[0] == 2


def test_uncovered_failed_ranges_ignore_recovered_and_split_windows():
    s = datetime(2026, 8, 25, tzinfo=timezone.utc)

    def entry(status, a, b):
        return {"status": status, "window_start": (s + timedelta(hours=a)).isoformat(),
                "window_end": (s + timedelta(hours=b)).isoformat()}

    manifest = {
        "parent": entry("split", 0, 8),
        "a": entry("succeeded", 0, 4),
        "b": entry("failed", 4, 8),
        "old": entry("failed", 8, 16),
        "old-retried": entry("succeeded", 8, 12),
        "late": entry("failed", 40, 48),
    }
    gaps = audit.uncovered_failed_ranges(manifest, s, s + timedelta(hours=24))
    assert gaps == [(s + timedelta(hours=4), s + timedelta(hours=8)), (s + timedelta(hours=12), s + timedelta(hours=16))]
    assert audit.uncovered_failed_ranges({"a": entry("succeeded", 0, 8)}, s, s + timedelta(hours=24)) == []


def test_golden_is_current_with_notebook():
    if not (os.environ.get("JAVA_HOME") or shutil.which("java")):
        pytest.skip("Spark/Java not available")
    pytest.importorskip("pyspark")
    problems = vg.diff(ag.read_expected(), ag.run_spark(vg.spark_session()))
    assert not problems, "\n".join(problems)


def test_pending_rechecks_are_listed_and_not_gaps():
    h8 = timedelta(hours=8)
    ws = datetime(2026, 8, 25, tzinfo=timezone.utc)
    manifest = {}
    manifest.update(_empty(ws, ws + h8, status="failed", recheck_pending=True))
    manifest.update(_empty(ws + h8, ws + 2 * h8, status="failed"))
    manifest.update(_empty(ws + 2 * h8, ws + 3 * h8))
    assert audit.pending_recheck_windows(manifest) == [(ws, ws + h8)]
    assert audit.pending_recheck_windows({}) == []
    assert audit.uncovered_failed_ranges(manifest, ws - h8, ws + 4 * h8) == [(ws + h8, ws + 2 * h8)]
