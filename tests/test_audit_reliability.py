"""Behavioral notebook checks for audit ingestion reliability and merge safety."""

import ast
import contextlib
import io
import json
import shutil
import tempfile
import threading
import time
import unittest
import uuid
from unittest import mock
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NOTEBOOKS = ROOT / "fabric" / "notebooks"
INGESTER = NOTEBOOKS / "Copilot_Audit_Log_Direct_Ingester.ipynb"
PROCESSOR = NOTEBOOKS / "Copilot_Audit_Log_Processor.ipynb"
SCRATCH = Path(tempfile.gettempdir()) / ("valuelens-audit-tests-" + uuid.uuid4().hex)

# Cell 10's audit-source code (Sentinel, the Management Activity API, and choosing between them).
SOURCE_NAMES = {
    "NoSourceForWindow", "SENTINEL_QUERY_VIA", "SENTINEL_WORKSPACE_ID", "SENTINEL_TABLE", "SENTINEL_PAGE_ROWS",
    "SENTINEL_RECORD_TYPES", "FEED_HOST", "FEED_PUBLISHER_ID", "FEED_DOWNLOAD_THREADS", "FEED_RETENTION",
    "FEED_MARGIN", "FEED_OVERLAP", "FEED_STATE", "SOURCE_PLAN", "PREFETCHED_KEYS", "_KQL_DATETIME",
    "_KQL_IDENTIFIER", "_USER_TYPES", "pick_window_source", "window_source", "_utc_seconds", "_seconds_dt",
    "_kql_string", "_kql_datetime", "_sentinel_table", "sentinel_page_query", "_parse_dynamic",
    "_is_size_limit_error", "run_sentinel_query", "sentinel_first_record", "sentinel_record", "_drain_sentinel",
    "_process_sentinel", "_feed_url", "_feed_headers", "_check_feed_url", "feed_ensure_subscription",
    "feed_list_content", "feed_download", "feed_record", "bucket_feed_records", "load_feed_state",
    "save_feed_state", "prefetch_feed", "plan_audit_sources", "drop_out_of_reach", "_window_fetch_source",
    "AUDIT_STATUS_TABLE", "SOURCE_LABELS", "SOURCE_STATUS", "_MISSING_SOURCE", "source_error_status",
    "source_status_rows", "write_source_status",
}


def cells(path):
    return ["".join(cell["source"]) for cell in json.loads(path.read_text(encoding="utf-8"))["cells"]]


def exec_notebook_cell(path, index, namespace):
    source = cells(path)[index]
    exec(compile(source, f"{path.name}:cell{index}", "exec"), namespace)
    return namespace


def exec_named_defs(path, index, names, namespace=None, include_imports=True):
    tree = ast.parse(cells(path)[index], filename=f"{path.name}:cell{index}")
    body = []
    wanted = set(names)
    for node in tree.body:
        if include_imports and isinstance(node, (ast.Import, ast.ImportFrom)):
            body.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in wanted:
            body.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in wanted for t in node.targets
        ):
            body.append(node)
    compiled = compile(ast.Module(body=body, type_ignores=[]), f"{path.name}:cell{index}", "exec")
    ns = {} if namespace is None else namespace
    exec(compiled, ns)
    return ns


class FakeCatalog:
    def __init__(self, exists=False):
        self._exists = exists

    def tableExists(self, _name):
        return self._exists


class FakeSpark:
    def __init__(self, exists=False):
        self.catalog = FakeCatalog(exists=exists)

    def table(self, _name):
        raise AssertionError("table() should not be called in this unit test path")


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class FakeNotebookUtilsFS:
    def __init__(self, root):
        self.root = Path(root)
        self.calls = []

    def _normalize(self, path):
        if not isinstance(path, str) or not path:
            raise AssertionError(f"unexpected path: {path!r}")
        return path.replace("\\", "/").rstrip("/")

    def _resolve(self, path):
        normalized = self._normalize(path)
        if normalized.startswith("file:"):
            return Path(normalized[5:])
        if normalized == "Files" or normalized.startswith("Files/"):
            relative = normalized[6:] if normalized.startswith("Files/") else ""
            return self.root / "Files" / Path(relative)
        if normalized.startswith("abfss://"):
            return self.root / "_abfss" / normalized.replace("://", "__", 1).replace("/", "_")
        raise AssertionError(f"unexpected notebookutils path: {path!r}")

    def exists(self, path):
        self.calls.append(("exists", path))
        return self._resolve(path).exists()

    def mkdirs(self, path):
        self.calls.append(("mkdirs", path))
        self._resolve(path).mkdir(parents=True, exist_ok=True)
        return True

    def ls(self, path):
        self.calls.append(("ls", path))
        base = self._resolve(path)
        if not base.exists():
            return []
        prefix = self._normalize(path)
        return [type("Entry", (), {"path": prefix + "/" + child.name})() for child in sorted(base.iterdir())]

    def rm(self, path, recurse=False):
        self.calls.append(("rm", path, recurse))
        target = self._resolve(path)
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
        return True

    def cp(self, src, dst):
        self.calls.append(("cp", src, dst))
        source = self._resolve(src)
        target = self._resolve(dst)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return True

    def mv(self, src, dst, create_path=False, overwrite=False):
        self.calls.append(("mv", src, dst, overwrite))
        source = self._resolve(src)
        target = self._resolve(dst)
        target.parent.mkdir(parents=True, exist_ok=True)
        if overwrite and target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        shutil.move(str(source), str(target))
        return True

    def head(self, *_args, **_kwargs):
        raise AssertionError("head() should not be used for manifest reads")


class AuditReliabilityTests(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.ingester_cell16 = cells(INGESTER)[16]
        cls.processor_cell15 = cells(PROCESSOR)[15]

    def setUp(self):
        shutil.rmtree(SCRATCH, ignore_errors=True)
        SCRATCH.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(SCRATCH, ignore_errors=True)

    def ingester_helpers(self):
        namespace = {
            "MODE": "incremental",
            "BACKFILL_DAYS": 180,
            "LOOKBACK_DAYS": 7,
            "CHUNK_HOURS": 8,
            "OUTPUT_TABLE": "dbo.Copilot_Interactions_Parsed",
            "spark": FakeSpark(exists=False),
            "_request": lambda *a, **k: None,
            "get_headers": lambda: {},
        }
        return exec_notebook_cell(INGESTER, 6, namespace)

    def stage_helpers(self):
        return exec_named_defs(
            INGESTER,
            10,
            {
                "_normalize_stage_dir",
                "_is_remote_stage_dir",
                "_stage_path_join",
                "_stage_basename",
                "_list_stage_paths",
                "_stage_exists",
                "_stage_remove",
                "_get_notebook_fs",
                "_ensure_stage_dir",
                "list_window_files",
                "purge_window_files",
                "list_active_stage_files",
                "manifest_succeeded",
                "should_refresh_window",
                "window_stage_files_reusable",
                "is_window_reusable",
            },
            {"_as_utc_datetime": self.ingester_helpers()["_as_utc_datetime"]},
        )

    def row_builder(self):
        return exec_named_defs(INGESTER, 10, {"_row"}, self.ingester_helpers())

    def processor_helpers(self):
        return exec_named_defs(
            PROCESSOR,
            2,
            {"normalize_actor_token", "classify_actor_environment", "resolve_write_strategy"},
            include_imports=False,
        )

    def query_helpers(self, namespace=None):
        ns = {
            "MAX_WAIT_MIN_PER_QUERY": 1,
            "POLL_INTERVAL_SEC": 0,
            "_request": lambda *a, **k: None,
            "get_headers": lambda: {},
        }
        if namespace:
            ns.update(namespace)
        ns.setdefault("RUN_DEADLINE", None)
        return exec_named_defs(
            INGESTER,
            8,
            {"AuditQueryFailed", "BudgetReached", "RecordLimitExceeded", "budget_exhausted", "check_budget",
             "_read_query_status", "wait_for_query"},
            ns,
        )

    def http_helpers(self, namespace=None):
        """Cell 4's quota exception, budget-aware wait and retry policy, without its session or token."""
        from urllib3.util.retry import Retry

        ns = {"Retry": Retry, "time": time}
        if namespace:
            ns.update(namespace)
        return exec_named_defs(
            INGESTER,
            4,
            {"THROTTLE_LISTENERS", "BUDGET_CHECKS", "QUOTA_RETRY_AFTER_SEC", "QueryQuotaReached", "_notify_throttle",
             "_wait", "_ThrottleAwareRetry"},
            ns,
            include_imports=False,
        )

    def checkpoint_helpers(self, namespace=None):
        ingester = self.ingester_helpers()
        query = self.query_helpers()
        ns = {
            "MODE": "incremental",
            "OUTPUT_TABLE": "dbo.Copilot_Interactions_Parsed",
            "MAX_CONCURRENT_QUERIES": 5,
            "MIN_CONCURRENT_QUERIES": 1,
            "WINDOW_RETRIES": 3,
            "MIN_CHUNK_HOURS": 1,
            "SPLIT_ON_TIMEOUT": True,
            "RETRY_BASE_SEC": 0,
            "RETRY_MAX_SEC": 0,
            "_TRANSIENT": {429, 500, 502, 503, 504},
            "AuditQueryFailed": query["AuditQueryFailed"],
            "BudgetReached": query["BudgetReached"],
            "RecordLimitExceeded": query["RecordLimitExceeded"],
            "QueryQuotaReached": self.http_helpers()["QueryQuotaReached"],
            "_wait": lambda seconds: None,
            "budget_exhausted": query["budget_exhausted"],
            "RUN_DEADLINE": None,
            "TIME_BUDGET_MIN": 0,
            "RESUME_QUERY_HOURS": 12,
            "TRAILING_REUSE_HOURS": 0,
            "QUERY_LIMITER": ingester["AdaptiveLimiter"](5, 1),
            "AdaptiveLimiter": ingester["AdaptiveLimiter"],
            "split_window": ingester["split_window"],
            "expand_split_windows": ingester["expand_split_windows"],
            "retry_delay": ingester["retry_delay"],
            "uncovered_failed_ranges": ingester["uncovered_failed_ranges"],
            "empty_recheck_windows": ingester["empty_recheck_windows"],
            "pending_recheck_windows": ingester["pending_recheck_windows"],
            "RECHECK_PENDING": "recheck_pending",
            "WRITE_MODE": "merge",
            "EMPTY_RECHECK_DAYS": 30,
            "EMPTY_RECHECK_MAX": 24,
            "STAGING_ABS": str(SCRATCH),
            "MANIFEST": str(SCRATCH / "_manifest.json"),
            "LOCAL_STAGE_TMP_DIR": str(SCRATCH),
            "MANIFEST_LOCK": threading.RLock(),
            "MANIFEST_TOUCHED": set(),
            "manifest": {},
            "LOOKBACK_DAYS": 7,
            "end_date": datetime(2026, 9, 10, tzinfo=timezone.utc),
            "datetime": datetime,
            "timedelta": timedelta,
            "timezone": timezone,
            "stable_window_key": ingester["stable_window_key"],
            "_as_utc_datetime": ingester["_as_utc_datetime"],
            "canonicalize_audit_record": ingester["canonicalize_audit_record"],
            "create_query": lambda ws, we: "qid-1",
            "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
            "_request": lambda *a, **k: None,
            "get_headers": lambda: {},
        }
        if namespace:
            ns.update(namespace)
        return exec_named_defs(
            INGESTER,
            10,
            {
                "_normalize_stage_dir",
                "_is_remote_stage_dir",
                "_stage_path_join",
                "_stage_basename",
                "_file_uri",
                "_driver_temp_root",
                "_new_local_temp_path",
                "_get_notebook_fs",
                "_ensure_stage_dir",
                "_list_stage_paths",
                "_stage_exists",
                "_stage_remove",
                "_write_stage_text",
                "_write_stage_jsonl",
                "_move_stage_file",
                "_read_stage_json",
                "list_window_files",
                "purge_window_files",
                "list_active_stage_files",
                "_allowed_manifest_statuses",
                "_validate_manifest_payload",
                "_load_manifest",
                "_manifest_temp_path",
                "_save_manifest",
                "manifest_succeeded",
                "should_refresh_window",
                "trailing_fresh_after",
                "resumable_query_id",
                "window_stage_files_reusable",
                "is_window_reusable",
                "_read_manifest_entry",
                "_manifest_entry_time",
                "_merge_other_runs",
                "_mark_window",
                "_row",
                "_is_graph_records_url",
                "_validate_graph_records_url",
                "_validate_records_page",
                "_drain",
                "_process",
                "QUOTA_PAUSED",
                "_FATAL_HTTP",
                "_http_status",
                "is_retryable_window_error",
                "_run_window",
                "leaf_windows",
                "_fmt_range",
                "assert_no_unrecovered_gaps",
                "fetch_windows",
                "plan_empty_rechecks",
                "clear_recheck_pending",
            } | SOURCE_NAMES,
            ns,
        )

    def remote_checkpoint_helpers(self, namespace=None):
        remote_root = SCRATCH / "_remote"
        fake_fs = FakeNotebookUtilsFS(remote_root)
        ns = {
            "STAGING_ABS": "Files/_audit_staging",
            "MANIFEST": "Files/_audit_staging/_manifest.json",
            "LOCAL_STAGE_TMP_DIR": str(SCRATCH / "_driver_tmp"),
            "NOTEBOOK_FS": fake_fs,
        }
        if namespace:
            ns.update(namespace)
        helpers = self.checkpoint_helpers(ns)
        helpers["_fake_fs"] = fake_fs
        helpers["_remote_root"] = remote_root
        return helpers

    def test_incremental_start_uses_trailing_overlap_but_still_catches_up_from_stale_watermark(self):
        ns = self.ingester_helpers()
        end_dt = datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc)
        self.assertEqual(
            ns["determine_incremental_start"](end_dt, end_dt - timedelta(days=2), 7),
            end_dt - timedelta(days=7),
        )
        self.assertEqual(
            ns["determine_incremental_start"](end_dt, end_dt - timedelta(days=30), 7),
            end_dt - timedelta(days=30),
        )

    def test_manifest_updates_preserve_memory_when_mounted_reads_are_stale(self):
        # Lakehouse mount reads can lag a successful atomic rename. A worker must
        # not replace newer process-local checkpoints with that older snapshot.
        ns = self.checkpoint_helpers()
        ns["manifest"]["completed-window"] = {"status": "succeeded"}
        ns["_load_manifest"] = lambda: {}
        ns["_mark_window"]("next-window", "waiting")
        self.assertEqual(ns["_read_manifest_entry"]("completed-window")["status"], "succeeded")
        persisted = json.loads(Path(ns["MANIFEST"]).read_text(encoding="utf-8"))
        self.assertEqual(persisted["completed-window"]["status"], "succeeded")

    def test_manifest_updates_keep_windows_another_run_saved(self):
        # A history recovery beside the daily load: each saves the manifest it loaded at the start.
        ns = self.checkpoint_helpers()
        ns["manifest"]["old-window"] = {"status": "waiting", "refreshed_at": "2026-11-02T20:00:00+00:00"}
        ns["manifest"]["mine"] = {"status": "succeeded", "completed_at": "2026-11-02T20:00:00+00:00"}
        ns["_load_manifest"] = lambda: {
            "feed-window": {"status": "succeeded", "source": "feed", "completed_at": "2026-11-02T22:30:00+00:00"},
            "old-window": {"status": "succeeded", "completed_at": "2026-11-02T22:00:00+00:00"},
            "mine": {"status": "failed", "refreshed_at": "2026-11-02T23:00:00+00:00"},
        }
        ns["_mark_window"]("mine", "succeeded", completed_at="2026-11-02T21:00:00+00:00")
        ns["_mark_window"]("next-window", "waiting")
        persisted = json.loads(Path(ns["MANIFEST"]).read_text(encoding="utf-8"))
        self.assertEqual(persisted["feed-window"]["source"], "feed")
        self.assertEqual(persisted["old-window"]["status"], "succeeded")
        # A window this run wrote keeps this run's entry.
        self.assertEqual(persisted["mine"]["status"], "succeeded")

    def test_manifest_merge_does_not_overwrite_an_unreadable_saved_manifest(self):
        ns = self.checkpoint_helpers()
        saved = {"other-run": {"status": "succeeded", "source": "feed"}}
        ns["_save_manifest"](saved)
        ns["manifest"]["kept"] = {"status": "succeeded"}

        def broken():
            raise RuntimeError("not valid JSON")

        ns["_load_manifest"] = broken
        with self.assertRaisesRegex(RuntimeError, "not valid JSON"):
            ns["_mark_window"]("next-window", "waiting")
        self.assertEqual(json.loads(Path(ns["MANIFEST"]).read_text(encoding="utf-8")), saved)
        self.assertEqual(ns["_read_manifest_entry"]("kept")["status"], "succeeded")
        self.assertNotIn("next-window", ns["manifest"])

    def test_synthetic_record_key_uses_canonical_json_and_ignores_array_order(self):
        ns = self.ingester_helpers()
        left = json.dumps(
            {
                "CopilotEventData": {
                    "Messages": [
                        {"isPrompt": "true", "Id": "msg-b"},
                        {"Id": "msg-a", "isPrompt": "true"},
                    ],
                    "AccessedResources": [
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                        {"SiteUrl": "https://a", "Action": "read", "Type": "docx"},
                    ],
                }
            }
        )
        right = json.dumps(
            {
                "CopilotEventData": {
                    "AccessedResources": [
                        {"Action": "read", "SiteUrl": "https://a", "Type": "docx"},
                        {"SiteUrl": "https://b", "Type": "docx", "Action": "read"},
                    ],
                    "Messages": [
                        {"Id": "msg-a", "isPrompt": "true"},
                        {"isPrompt": "true", "Id": "msg-b"},
                    ],
                }
            }
        )

        self.assertEqual(
            ns["build_source_record_key"](None, "2026-09-10T08:00:00Z", "View", left),
            ns["build_source_record_key"](None, "2026-09-10T08:00:00Z", "View", right),
        )

    def test_stage_row_builder_uses_canonical_identity_and_preserves_real_ids(self):
        row = self.row_builder()["_row"]
        record_a = {
            "id": "record-1",
            "createdDateTime": "2026-09-10T08:00:00Z",
            "auditLogRecordType": "copilotInteraction",
            "operation": "View",
            "associatedAdminUnits": [],
            "associatedAdminUnitsNames": [],
            "auditData": {
                "CreationTime": "2026-09-10T08:00:00Z",
                "CopilotEventData": {
                    "Messages": [
                        {"Id": "msg-b", "isPrompt": "true"},
                        {"isPrompt": "true", "Id": "msg-a"},
                    ],
                    "AccessedResources": [
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                        {"Action": "read", "SiteUrl": "https://a", "Type": "docx"},
                    ],
                },
            },
        }
        record_b = {
            **record_a,
            "auditData": {
                "CopilotEventData": {
                    "AccessedResources": [
                        {"SiteUrl": "https://a", "Type": "docx", "Action": "read"},
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                    ],
                    "Messages": [
                        {"Id": "msg-a", "isPrompt": "true"},
                        {"isPrompt": "true", "Id": "msg-b"},
                    ],
                },
                "CreationTime": "2026-09-10T08:00:00Z",
            },
        }

        row_a = row(record_a)
        row_b = row(record_b)
        audit = json.loads(row_a["AuditData"])

        self.assertEqual(row_a["SourceRecordKey"], "rid:record-1")
        self.assertEqual(row_a["SourceRecordKey"], row_b["SourceRecordKey"])
        self.assertEqual(row_a["AuditData"], row_b["AuditData"])
        self.assertEqual(
            [message["_StableKey"] for message in audit["CopilotEventData"]["Messages"]],
            ["mid:msg-a", "mid:msg-b"],
        )
        self.assertEqual(
            [resource["_StableOrdinal"] for resource in audit["CopilotEventData"]["AccessedResources"]],
            [0, 1],
        )

    def test_missing_message_ids_use_content_fingerprint_plus_occurrence_not_position(self):
        ns = self.ingester_helpers()
        payload_a = ns["canonicalize_audit_payload"](
            {
                "CopilotEventData": {
                    "Messages": [
                        {"isPrompt": "true", "Text": "Alpha"},
                        {"Text": "Beta", "isPrompt": "true"},
                        {"Text": "Alpha", "isPrompt": "true"},
                    ]
                }
            }
        )
        payload_b = ns["canonicalize_audit_payload"](
            {
                "CopilotEventData": {
                    "Messages": [
                        {"Text": "Alpha", "isPrompt": "true"},
                        {"isPrompt": "true", "Text": "Alpha"},
                        {"isPrompt": "true", "Text": "Beta"},
                    ]
                }
            }
        )

        keys_a = [message["_StableKey"] for message in payload_a["CopilotEventData"]["Messages"]]
        keys_b = [message["_StableKey"] for message in payload_b["CopilotEventData"]["Messages"]]
        self.assertEqual(keys_a, keys_b)
        self.assertEqual(len(keys_a), 3)
        self.assertEqual(len(set(keys_a)), 3)
        self.assertTrue(any(key.endswith("#2") for key in keys_a))

    def test_repeated_resources_keep_distinct_stable_keys_after_canonical_sort(self):
        ns = self.ingester_helpers()
        payload_a = ns["canonicalize_audit_payload"](
            {
                "CopilotEventData": {
                    "AccessedResources": [
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://a"},
                        {"Action": "read", "SiteUrl": "https://a", "Type": "docx"},
                    ]
                }
            }
        )
        payload_b = ns["canonicalize_audit_payload"](
            {
                "CopilotEventData": {
                    "AccessedResources": [
                        {"Action": "read", "SiteUrl": "https://a", "Type": "docx"},
                        {"Type": "docx", "Action": "read", "SiteUrl": "https://b"},
                        {"SiteUrl": "https://a", "Type": "docx", "Action": "read"},
                    ]
                }
            }
        )

        keys_a = [resource["_StableKey"] for resource in payload_a["CopilotEventData"]["AccessedResources"]]
        keys_b = [resource["_StableKey"] for resource in payload_b["CopilotEventData"]["AccessedResources"]]
        self.assertEqual(keys_a, keys_b)
        self.assertEqual(len(keys_a), 3)
        self.assertEqual(len(set(keys_a)), 3)
        self.assertTrue(any(key.endswith("#2") for key in keys_a))

    def test_legacy_incremental_table_without_new_keys_fails_clearly(self):
        ns = self.ingester_helpers()
        with self.assertRaisesRegex(RuntimeError, "missing stable key columns"):
            ns["validate_incremental_target_columns"](
                ["CreationDate", "RecordId", "Message_Id"],
                ns["KEY_COLUMNS"],
                "dbo.Copilot_Interactions_Parsed",
            )

    def test_stage_scope_reuses_recent_windows_only_and_cleans_partial_files(self):
        helpers = self.stage_helpers()
        recent_key = "v2_recent"
        old_key = "v2_old"
        recent = SCRATCH / f"win_{recent_key}_0000.jsonl"
        old = SCRATCH / f"win_{old_key}_0000.jsonl"
        partial = SCRATCH / f"win_{recent_key}_0001.jsonl.partial"
        recent.write_text("{}", encoding="utf-8")
        old.write_text("{}", encoding="utf-8")
        partial.write_text("{}", encoding="utf-8")

        scoped = [Path(p).name for p in helpers["list_active_stage_files"](str(SCRATCH), {recent_key})]
        self.assertEqual(scoped, [recent.name])
        removed = helpers["purge_window_files"](str(SCRATCH), recent_key, include_partial=True)
        self.assertEqual(removed, 2)
        self.assertFalse(recent.exists())
        self.assertFalse(partial.exists())
        self.assertTrue(old.exists())

    def test_remote_stage_publication_uses_notebookutils_without_mount_paths(self):
        ingester = self.ingester_helpers()
        win = (
            datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        )
        key = ingester["stable_window_key"](*win)
        start_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-remote/records?$top=999"
        payload = {
            "value": [
                {
                    "id": "record-1",
                    "createdDateTime": "2026-09-10T08:00:00Z",
                    "auditLogRecordType": "copilotInteraction",
                    "operation": "View",
                    "associatedAdminUnits": [],
                    "associatedAdminUnitsNames": [],
                    "auditData": {"CreationTime": "2026-09-10T08:00:00Z"},
                }
            ]
        }
        helpers = self.remote_checkpoint_helpers(
            {
                "create_query": lambda ws, we: "qid-remote",
                "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
                "_request": lambda method, url, **kwargs: FakeResponse(payload if url == start_url else {"value": []}),
            }
        )

        self.assertEqual(helpers["_process"](win), (key, 1, "done"))
        self.assertEqual(
            helpers["list_window_files"](helpers["STAGING_ABS"], key),
            [f"Files/_audit_staging/win_{key}_0000.jsonl"],
        )
        manifest = helpers["_load_manifest"]()
        self.assertEqual(manifest[key]["status"], "succeeded")
        self.assertEqual(manifest[key]["files"], [f"win_{key}_0000.jsonl"])
        self.assertFalse((helpers["_remote_root"] / "Files" / "_audit_staging" / f"win_{key}_0000.jsonl.partial").exists())
        self.assertTrue(all("/lakehouse/default" not in str(call) for call in helpers["_fake_fs"].calls))

    def test_failed_remote_delete_cannot_publish_stale_pages_as_empty_success(self):
        win = (
            datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        )
        key = self.ingester_helpers()["stable_window_key"](*win)
        helpers = self.remote_checkpoint_helpers({
            "create_query": lambda ws, we: "qid-empty",
            "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
            "_request": lambda *args, **kwargs: FakeResponse({"value": []}),
        })
        fs = helpers["_fake_fs"]
        stale_path = f"Files/_audit_staging/win_{key}_0000.jsonl"
        stale = fs._resolve(stale_path)
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_text('{"id":"stale"}\n', encoding="utf-8")
        original_rm = fs.rm
        fs.rm = lambda path, recurse=False: False if path == stale_path else original_rm(path, recurse)

        with self.assertRaisesRegex(RuntimeError, "Failed to remove staged file"):
            helpers["_process"](win)
        self.assertTrue(stale.exists())
        self.assertEqual(helpers["_load_manifest"]()[key]["status"], "failed")
        self.assertIn("Failed to remove staged file", helpers["_load_manifest"]()[key]["error"])

    def test_remote_copy_and_move_false_results_are_fatal(self):
        for operation in ("cp", "mv"):
            with self.subTest(operation=operation):
                helpers = self.remote_checkpoint_helpers()
                setattr(helpers["_fake_fs"], operation, lambda *args: False)
                with self.assertRaisesRegex(RuntimeError, "Failed to (copy|move)"):
                    helpers["_mark_window"]("failed-publish", "succeeded", rows=0)
                self.assertNotIn("failed-publish", helpers["manifest"])
                self.assertEqual(helpers["_load_manifest"](), {})

    def test_missing_published_files_force_refresh_instead_of_stale_skip(self):
        helpers = self.stage_helpers()
        cutoff = datetime(2026, 9, 3, tzinfo=timezone.utc)
        old_end = datetime(2026, 8, 15, tzinfo=timezone.utc)
        entry = {"status": "succeeded", "rows": 3, "pages": 1, "files": ["win_v2_old_0000.jsonl"]}

        self.assertFalse(helpers["window_stage_files_reusable"](str(SCRATCH), "v2_old", entry))
        self.assertFalse(helpers["is_window_reusable"](str(SCRATCH), "v2_old", old_end, entry, cutoff))

    def test_recent_completed_windows_requery_for_late_arrivals_but_old_completed_windows_skip(self):
        helpers = self.stage_helpers()
        cutoff = datetime(2026, 9, 3, tzinfo=timezone.utc)
        recent_end = datetime(2026, 9, 9, tzinfo=timezone.utc)
        old_end = datetime(2026, 8, 15, tzinfo=timezone.utc)
        succeeded = {"status": "succeeded", "completed_at": "2026-09-01T00:00:00+00:00"}

        self.assertTrue(helpers["should_refresh_window"](recent_end, succeeded, cutoff))
        self.assertFalse(helpers["should_refresh_window"](old_end, succeeded, cutoff))
        self.assertTrue(helpers["should_refresh_window"](old_end, {"status": "failed"}, cutoff))

    def test_processor_merge_strategy_is_explicit_and_never_silent_overwrite_on_missing_id(self):
        helpers = self.processor_helpers()
        self.assertEqual(
            helpers["resolve_write_strategy"]("overwrite", ["CreationDate"], True, [], ["Id"]),
            "overwrite",
        )
        self.assertEqual(
            helpers["resolve_write_strategy"]("merge", ["Id"], False, [], ["Id"]),
            "overwrite",
        )
        with self.assertRaisesRegex(RuntimeError, "requires source key columns"):
            helpers["resolve_write_strategy"]("merge", ["CreationDate"], True, ["Id"], ["Id"])
        with self.assertRaisesRegex(RuntimeError, "requires non-blank values"):
            helpers["resolve_write_strategy"]("merge", ["Id"], True, ["Id"], ["Id"], source_key_health=False)
        with self.assertRaisesRegex(RuntimeError, "missing merge key columns"):
            helpers["resolve_write_strategy"]("merge", ["Id"], True, ["CreationDate"], ["Id"])

    def test_processor_actor_environment_restores_agent_and_cowork_paths(self):
        helpers = self.processor_helpers()
        self.assertEqual(helpers["classify_actor_environment"](app_host="autonomous"), "Agents")
        self.assertEqual(helpers["classify_actor_environment"](app_host="m365 cowork canvas"), "Cowork")
        self.assertEqual(
            helpers["classify_actor_environment"](agent_name="Sales Copilot Agent", environment="Licensed"),
            "Agents",
        )
        self.assertEqual(helpers["classify_actor_environment"](app_host="word", environment="Licensed"), "User")

    def test_notebooks_share_stable_id_contract(self):
        for token in ["'Id'", "'Source_RecordKey'", "'Source_MessageKey'", "'Source_ResourceKey'"]:
            self.assertIn(token, self.ingester_cell16)
        self.assertIn("MERGE_KEYS       = [\"Id\"]", cells(PROCESSOR)[1])
        self.assertIn("resolve_write_strategy(WRITE_MODE, src_all.columns", cells(PROCESSOR)[3])
        self.assertIn("canonicalize_audit_record", cells(INGESTER)[10])
        self.assertIn("SourceRecordKey", cells(INGESTER)[12])
        self.assertIn("ArrayType", cells(INGESTER)[12])
        self.assertIn("msg._StableKey", self.ingester_cell16)
        self.assertIn("res._StableKey", self.ingester_cell16)
        self.assertIn("ambiguous synthetic SourceRecordKey", self.ingester_cell16)
        self.assertIn("dropDuplicates(['Id'])", self.ingester_cell16)

    def test_wait_for_query_distinguishes_success_failure_and_malformed_status(self):
        responses = iter(
            [
                FakeResponse({"status": "running"}),
                FakeResponse({"status": "succeeded", "id": "qid-success"}),
            ]
        )
        helpers = self.query_helpers({"_request": lambda *a, **k: next(responses)})
        payload = helpers["wait_for_query"]("qid-success", max_wait_min=1)
        self.assertEqual(payload["status"], "succeeded")

        helpers = self.query_helpers({"_request": lambda *a, **k: FakeResponse({"status": "failed"})})
        with self.assertRaisesRegex(RuntimeError, "ended with status: failed"):
            helpers["wait_for_query"]("qid-failed", max_wait_min=1)

        helpers = self.query_helpers({"_request": lambda *a, **k: FakeResponse({})})
        with self.assertRaisesRegex(RuntimeError, "missing/invalid status"):
            helpers["wait_for_query"]("qid-malformed", max_wait_min=1)

    def test_manifest_load_allows_absent_but_rejects_corrupt_shape_and_status(self):
        helpers = self.checkpoint_helpers()
        manifest_path = Path(helpers["MANIFEST"])

        self.assertEqual(helpers["_load_manifest"](), {})

        manifest_path.write_text("{bad json", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "not valid JSON"):
            helpers["_load_manifest"]()

        manifest_path.write_text("[]", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "must be a JSON object"):
            helpers["_load_manifest"]()

        manifest_path.write_text(json.dumps({"win_bad": {"status": "done"}}), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "invalid status"):
            helpers["_load_manifest"]()

    def test_threaded_checkpoint_updates_persist_valid_json(self):
        helpers = self.checkpoint_helpers()
        manifest_path = Path(helpers["MANIFEST"])

        def update(index):
            helpers["_mark_window"](
                f"v2_{index:03d}",
                "succeeded",
                rows=index,
                completed_at=f"2026-09-10T00:{index % 60:02d}:00+00:00",
            )

        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(update, range(100)))

        persisted = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(len(persisted), 100)
        self.assertEqual(helpers["_load_manifest"](), persisted)
        self.assertTrue(all(entry["status"] == "succeeded" for entry in persisted.values()))
        self.assertFalse(list(SCRATCH.glob(".*.tmp")))

    def test_remote_manifest_roundtrip_avoids_truncated_head_reads(self):
        helpers = self.remote_checkpoint_helpers()

        for index in range(40):
            helpers["_mark_window"](
                f"v2_{index:03d}",
                "succeeded",
                rows=index,
                pages=index % 3,
                completed_at=f"2026-09-10T00:{index % 60:02d}:00+00:00",
            )

        manifest = helpers["_load_manifest"]()
        self.assertEqual(len(manifest), 40)
        self.assertEqual(manifest, helpers["manifest"])

    def test_drain_accepts_empty_page_but_rejects_malformed_payloads_and_off_graph_links(self):
        helpers = self.checkpoint_helpers({"_request": lambda *a, **k: FakeResponse({"value": []})})
        self.assertEqual(helpers["_drain"]("qid-empty", "empty"), (0, 0))
        self.assertEqual(helpers["list_window_files"](str(SCRATCH), "empty", include_partial=True), [])

        helpers = self.checkpoint_helpers({"_request": lambda *a, **k: FakeResponse({})})
        with self.assertRaisesRegex(RuntimeError, "missing value list"):
            helpers["_drain"]("qid-missing", "missing")

        helpers = self.checkpoint_helpers({"_request": lambda *a, **k: FakeResponse({"value": ["oops"]})})
        with self.assertRaisesRegex(RuntimeError, "item 0 must be an object"):
            helpers["_drain"]("qid-items", "items")

        helpers = self.checkpoint_helpers(
            {
                "_request": lambda *a, **k: FakeResponse(
                    {"value": [], "@odata.nextLink": "https://example.com/not-graph"}
                )
            }
        )
        with self.assertRaisesRegex(RuntimeError, "non-Graph records continuation URL"):
            helpers["_drain"]("qid-offgraph", "offgraph")

    def test_process_cleans_partial_files_and_marks_failed_on_wait_or_paging_errors(self):
        ingester = self.ingester_helpers()
        win = (
            datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        )
        key = ingester["stable_window_key"](*win)

        helpers = self.checkpoint_helpers(
            {
                "create_query": lambda ws, we: "qid-failed",
                "wait_for_query": lambda qid: (_ for _ in ()).throw(
                    RuntimeError(f"Query {qid} ended with status: failed")
                ),
            }
        )
        with self.assertRaisesRegex(RuntimeError, "ended with status: failed"):
            helpers["_process"](win)
        failed_manifest = json.loads(Path(helpers["MANIFEST"]).read_text(encoding="utf-8"))
        self.assertEqual(failed_manifest[key]["status"], "failed")
        self.assertNotIn("succeeded", failed_manifest[key]["status"])
        self.assertEqual(helpers["list_window_files"](str(SCRATCH), key, include_partial=True), [])

        start_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-cycle/records?$top=999"
        loop_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-cycle/records?$skiptoken=abc"
        pages = {
            start_url: FakeResponse({"value": [{}], "@odata.nextLink": loop_url}),
            loop_url: FakeResponse({"value": [{}], "@odata.nextLink": start_url}),
        }
        helpers = self.checkpoint_helpers(
            {
                "create_query": lambda ws, we: "qid-cycle",
                "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
                "_request": lambda method, url, **kwargs: pages[url],
            }
        )
        with self.assertRaisesRegex(RuntimeError, "repeated pagination link cycle"):
            helpers["_process"](win)
        failed_manifest = json.loads(Path(helpers["MANIFEST"]).read_text(encoding="utf-8"))
        self.assertEqual(failed_manifest[key]["status"], "failed")
        self.assertIn("pagination link cycle", failed_manifest[key]["error"])
        self.assertEqual(helpers["list_window_files"](str(SCRATCH), key, include_partial=True), [])

    def test_remote_failures_cleanup_partial_pages_and_keep_manifest_authoritative(self):
        ingester = self.ingester_helpers()
        win = (
            datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        )
        key = ingester["stable_window_key"](*win)
        start_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-bad/records?$top=999"
        next_url = "https://graph.microsoft.com/beta/security/auditLog/queries/qid-bad/records?$skiptoken=1"
        pages = {
            start_url: FakeResponse(
                {
                    "value": [
                        {
                            "id": "record-1",
                            "createdDateTime": "2026-09-10T08:00:00Z",
                            "auditData": {"CreationTime": "2026-09-10T08:00:00Z"},
                        }
                    ],
                    "@odata.nextLink": next_url,
                }
            ),
            next_url: FakeResponse({}),
        }
        helpers = self.remote_checkpoint_helpers(
            {
                "create_query": lambda ws, we: "qid-bad",
                "wait_for_query": lambda qid: {"status": "succeeded", "id": qid},
                "_request": lambda method, url, **kwargs: pages[url],
            }
        )

        with self.assertRaisesRegex(RuntimeError, "missing value list"):
            helpers["_process"](win)
        manifest = helpers["_load_manifest"]()
        self.assertEqual(manifest[key]["status"], "failed")
        self.assertEqual(helpers["list_window_files"](helpers["STAGING_ABS"], key, include_partial=True), [])


class AgentIdentityTests(unittest.TestCase):
    """Agent accounts such as SecurityCopilotAgentUser-<id> are not people."""

    @classmethod
    def setUpClass(cls):
        ns = exec_named_defs(PROCESSOR, 2, ["agent_identity_regex"], include_imports=False)
        cls.regex = staticmethod(ns["agent_identity_regex"])
        cls.config = exec_notebook_cell(PROCESSOR, 1, {})
        cls.sources = cells(PROCESSOR)

    def default_regex(self):
        return self.regex(self.config["EXCLUDE_AGENT_IDENTITIES"], self.config["AGENT_IDENTITY_PATTERNS"])

    def test_default_config_drops_security_copilot_agents(self):
        import re
        self.assertIs(self.config["EXCLUDE_AGENT_IDENTITIES"], True)
        pattern = self.default_regex()
        self.assertTrue(re.search(pattern, "securitycopilotagentuser-1f2e3d4c@contoso.onmicrosoft.com"))
        for upn in ("jane@contoso.com", "agent.smith@contoso.com", "me-securitycopilotagentuser-1@contoso.com"):
            with self.subTest(upn=upn):
                self.assertIsNone(re.search(pattern, upn))

    def test_filter_can_be_switched_off_or_left_empty(self):
        self.assertIsNone(self.regex(False, [r"^securitycopilotagentuser-"]))
        self.assertIsNone(self.regex(True, []))
        self.assertIsNone(self.regex(True, None))
        self.assertIsNone(self.regex(True, ["", "  "]))

    def test_several_patterns_combine_into_one_regex(self):
        import re
        pattern = self.regex(True, [r"^svc-", r"@agents\.contoso\.com$"])
        self.assertEqual(pattern, r"(?:^svc-)|(?:@agents\.contoso\.com$)")
        self.assertTrue(re.search(pattern, "svc-bot@contoso.com"))
        self.assertTrue(re.search(pattern, "x@agents.contoso.com"))
        self.assertIsNone(re.search(pattern, "jane@contoso.com"))

    def test_processor_filters_new_rows_and_rebuilds_when_the_filter_changes(self):
        filter_cell = next(text for text in self.sources if "# 6b. AGENT IDENTITIES" in text)
        self.assertIn("AGENT_IDENTITY_REGEX = agent_identity_regex(EXCLUDE_AGENT_IDENTITIES, AGENT_IDENTITY_PATTERNS)", filter_cell)
        self.assertIn('F.lower(F.col("_NormUPN")).rlike(AGENT_IDENTITY_REGEX)', filter_cell)
        self.assertLess(filter_cell.index('fact = fact.withColumn("_NormUPN", norm)'), filter_cell.index("# 6b."))
        # Switching the filter on (or changing the patterns) changes the settings
        # fingerprint, so the next run rebuilds every month and drops rows written before.
        planner = next(text for text in self.sources if "PROCESSOR_CONFIG = processor_config_fingerprint(" in text)
        self.assertIn('"exclude_agent_identities": bool(EXCLUDE_AGENT_IDENTITIES)', planner)
        self.assertIn('"agent_identity_patterns": list(AGENT_IDENTITY_PATTERNS or [])', planner)


class FakeAuditGraph:
    """Fake Graph audit query API: create_query / wait_for_query / records pages, with scripted failures."""

    def __init__(self, failed, outcome=None):
        self.failed = failed
        self.outcome = outcome or (lambda ws, we, attempt: "succeeded")
        self.created = []
        self.ranges = {}
        self.lock = threading.Lock()

    def attempts(self, ws, we):
        return sum(1 for r in self.created if r == (ws, we))

    def create_query(self, ws, we):
        with self.lock:
            self.created.append((ws, we))
            qid = f"q{len(self.created)}"
            self.ranges[qid] = (ws, we, self.attempts(ws, we))
        return qid

    def wait_for_query(self, qid):
        status = self.outcome(*self.ranges[qid])
        if status == "timeout":
            raise TimeoutError(f"Query {qid} did not finish")
        if status != "succeeded":
            raise self.failed(f"Query {qid} ended with status: {status}")
        return {"status": "succeeded", "id": qid}

    def request(self, method, url, **_kwargs):
        qid = url.split("/queries/")[1].split("/")[0]
        ws, _we, _attempt = self.ranges[qid]
        return FakeResponse({"value": [{"id": f"{ws:%Y%m%d%H%M}", "createdDateTime": ws.isoformat()}]})


class FailedWindowRecoveryTests(unittest.TestCase):
    """Failed audit query windows are retried with a new query, then split, and never written partially."""

    setUp = AuditReliabilityTests.setUp
    tearDown = AuditReliabilityTests.tearDown
    ingester_helpers = AuditReliabilityTests.ingester_helpers
    query_helpers = AuditReliabilityTests.query_helpers
    checkpoint_helpers = AuditReliabilityTests.checkpoint_helpers
    http_helpers = AuditReliabilityTests.http_helpers

    WIN = (datetime(2026, 8, 25, 0, tzinfo=timezone.utc), datetime(2026, 8, 25, 8, tzinfo=timezone.utc))
    NEXT = (datetime(2026, 8, 25, 8, tzinfo=timezone.utc), datetime(2026, 8, 25, 16, tzinfo=timezone.utc))

    def run_helpers(self, outcome, **config):
        failed = self.query_helpers()["AuditQueryFailed"]
        graph = FakeAuditGraph(failed, outcome)
        ns = {
            "AuditQueryFailed": failed,
            "create_query": graph.create_query,
            "wait_for_query": graph.wait_for_query,
            "_request": graph.request,
        }
        ns.update(config)
        helpers = self.checkpoint_helpers(ns)
        helpers["manifest"].update(helpers["_load_manifest"]())
        return helpers, graph

    def key(self, helpers, win):
        return helpers["stable_window_key"](*win)

    def test_failed_query_is_resubmitted_as_a_new_query_and_succeeds(self):
        helpers, graph = self.run_helpers(lambda ws, we, attempt: "failed" if attempt == 1 else "succeeded")
        keys, rows = helpers["fetch_windows"]([self.WIN])
        key = self.key(helpers, self.WIN)
        self.assertEqual(keys, {key})
        self.assertEqual(rows, 1)
        self.assertEqual(graph.attempts(*self.WIN), 2)
        entry = helpers["_load_manifest"]()[key]
        self.assertEqual(entry["status"], "succeeded")
        self.assertEqual(entry["attempts"], 2)
        self.assertEqual(len(entry["attempt_errors"]), 1)
        self.assertIn("ended with status: failed", entry["attempt_errors"][0])
        self.assertIsNone(entry["error"])
        self.assertEqual(helpers["QUERY_LIMITER"].limit, 4)

    def test_cancelled_query_is_retried_too(self):
        helpers, graph = self.run_helpers(lambda ws, we, attempt: "cancelled" if attempt < 3 else "succeeded")
        helpers["fetch_windows"]([self.WIN])
        self.assertEqual(graph.attempts(*self.WIN), 3)

    def test_persistent_failure_splits_window_and_halves_complete_the_parent(self):
        always_fails_at_8h = lambda ws, we, attempt: "failed" if we - ws == timedelta(hours=8) else "succeeded"
        helpers, graph = self.run_helpers(always_fails_at_8h, WINDOW_RETRIES=1)
        keys, rows = helpers["fetch_windows"]([self.WIN, self.NEXT])
        ws, we = self.WIN
        mid = ws + timedelta(hours=4)
        halves = [(ws, mid), (mid, we)]
        manifest = helpers["_load_manifest"]()
        parent = manifest[self.key(helpers, self.WIN)]
        self.assertEqual(parent["status"], "split")
        self.assertEqual(parent["parts"], [self.key(helpers, h) for h in halves])
        self.assertEqual(graph.attempts(*self.WIN), 2)
        for half in halves:
            self.assertEqual(manifest[self.key(helpers, half)]["status"], "succeeded")
        self.assertEqual(len(keys), 4)
        self.assertNotIn(self.key(helpers, self.WIN), keys)
        self.assertEqual(rows, 4)
        staged = helpers["list_active_stage_files"](str(SCRATCH), keys)
        self.assertEqual(len(staged), 4)
        self.assertFalse(helpers["list_window_files"](str(SCRATCH), self.key(helpers, self.WIN), include_partial=True))

        # A rerun reuses the parts and does not query the parent again.
        rerun, graph2 = self.run_helpers(lambda *a: self.fail("nothing should be queried"))
        self.assertEqual(rerun["fetch_windows"]([self.WIN, self.NEXT]), (keys, rows))
        self.assertEqual(graph2.created, [])

    def test_timeout_splits_at_once_when_configured(self):
        helpers, graph = self.run_helpers(
            lambda ws, we, attempt: "timeout" if we - ws == timedelta(hours=8) else "succeeded"
        )
        keys, _ = helpers["fetch_windows"]([self.WIN])
        self.assertEqual(graph.attempts(*self.WIN), 1)
        self.assertEqual(len(keys), 2)

    def test_failure_at_minimum_size_stops_with_one_clear_error_and_writes_nothing(self):
        bad_day = lambda ws, we, attempt: "failed" if ws < self.WIN[1] else "succeeded"
        helpers, graph = self.run_helpers(bad_day, MODE="backfill", WINDOW_RETRIES=1, MIN_CHUNK_HOURS=4)
        with self.assertRaises(RuntimeError) as caught:
            helpers["fetch_windows"]([self.WIN, self.NEXT])
        message = str(caught.exception)
        self.assertIn("2 audit window(s) still failed", message)
        self.assertIn("Nothing was written to dbo.Copilot_Interactions_Parsed", message)
        self.assertIn("2026-08-25 00:00 -> 2026-08-25 04:00 UTC", message)
        self.assertIn("2026-08-25 04:00 -> 2026-08-25 08:00 UTC", message)
        self.assertIn("rerun with MODE='backfill'; succeeded windows are reused", message)
        # The healthy window was still fetched (the run did not abort on the first failure) ...
        manifest = helpers["_load_manifest"]()
        self.assertEqual(manifest[self.key(helpers, self.NEXT)]["status"], "succeeded")
        # ... the 4h halves were each tried twice and left no staged data behind.
        for half in [(self.WIN[0], self.WIN[0] + timedelta(hours=4)), (self.WIN[0] + timedelta(hours=4), self.WIN[1])]:
            self.assertEqual(graph.attempts(*half), 2)
            self.assertEqual(manifest[self.key(helpers, half)]["status"], "failed")
            self.assertFalse(helpers["list_window_files"](str(SCRATCH), self.key(helpers, half), include_partial=True))

        # A rerun queries only the failed halves.
        rerun, graph2 = self.run_helpers(lambda *a: "succeeded", MODE="backfill", MIN_CHUNK_HOURS=4)
        keys, _ = rerun["fetch_windows"]([self.WIN, self.NEXT])
        self.assertEqual(len(keys), 3)
        self.assertEqual(sorted(we - ws for ws, we in graph2.created), [timedelta(hours=4)] * 2)

    def test_budget_reached_while_waiting_keeps_the_query_for_the_retry(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        budget = helpers["BudgetReached"]

        def wait_then_run_out(qid):
            if graph.ranges[qid][:2] == self.WIN:
                raise budget("still running")
            return graph.wait_for_query(qid)

        helpers["wait_for_query"] = wait_then_run_out
        with self.assertRaisesRegex(RuntimeError, "Time budget"):
            helpers["fetch_windows"]([self.WIN, self.NEXT])
        manifest = helpers["_load_manifest"]()
        paused = manifest[self.key(helpers, self.WIN)]
        self.assertEqual(paused["status"], "waiting")
        self.assertEqual(paused["query_id"], "q1")
        self.assertIn("paused_at", paused)
        self.assertEqual(manifest[self.key(helpers, self.NEXT)]["status"], "succeeded")

        # The retry re-polls q1 instead of queueing a new query, and reuses the finished window.
        rerun, graph2 = self.run_helpers(lambda *a: self.fail("nothing new should be queried"))
        graph2.ranges["q1"] = (*self.WIN, 1)
        rerun["wait_for_query"] = lambda qid: {"status": "succeeded", "id": qid}
        keys, rows = rerun["fetch_windows"]([self.WIN, self.NEXT])
        self.assertEqual(graph2.created, [])
        self.assertEqual(len(keys), 2)
        self.assertEqual(rows, 2)
        self.assertEqual(rerun["_load_manifest"]()[self.key(helpers, self.WIN)]["status"], "succeeded")

    def test_budget_already_spent_starts_no_queries(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded", RUN_DEADLINE=time.monotonic() - 1, TIME_BUDGET_MIN=1)
        with self.assertRaisesRegex(RuntimeError, "Time budget of 1 min reached with 2 audit window"):
            helpers["fetch_windows"]([self.WIN, self.NEXT])
        self.assertEqual(graph.created, [])

    THIRD = (datetime(2026, 8, 25, 16, tzinfo=timezone.utc), datetime(2026, 8, 26, 0, tzinfo=timezone.utc))

    def test_daily_search_limit_keeps_finished_windows_and_sends_no_more_searches(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded", MAX_CONCURRENT_QUERIES=1)
        quota = helpers["QueryQuotaReached"]
        refused = []

        def create(ws, we):
            if (ws, we) == self.WIN:
                refused.append((ws, we))
                raise quota("Graph refused a new audit search for the tenant (HTTP 429)")
            return graph.create_query(ws, we)

        helpers["create_query"] = create
        with self.assertRaisesRegex(RuntimeError, r"refused new audit searches for this tenant \(HTTP 429\) with 2 audit window"):
            helpers["fetch_windows"]([self.NEXT, self.WIN, self.THIRD])
        # One refusal stops the run sending searches: THIRD is never tried.
        self.assertEqual(graph.created, [self.NEXT])
        self.assertEqual(refused, [self.WIN])
        manifest = helpers["_load_manifest"]()
        self.assertEqual(manifest[self.key(helpers, self.NEXT)]["status"], "succeeded")
        throttled = manifest[self.key(helpers, self.WIN)]
        self.assertEqual(throttled["status"], "waiting")
        self.assertIn("throttled_at", throttled)
        self.assertNotIn(self.key(helpers, self.THIRD), manifest)

        # The next run fetches only what's left.
        rerun, graph2 = self.run_helpers(lambda *a: "succeeded")
        keys, rows = rerun["fetch_windows"]([self.NEXT, self.WIN, self.THIRD])
        self.assertEqual(sorted(graph2.created), sorted([self.WIN, self.THIRD]))
        self.assertEqual(len(keys), 3)
        self.assertEqual(rows, 3)

    def test_search_limit_while_waiting_keeps_the_query_for_the_next_run(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        quota = helpers["QueryQuotaReached"]

        def wait_then_throttle(qid):
            if graph.ranges[qid][:2] == self.WIN:
                raise quota("Graph asked to wait 3600s before the next audit request (HTTP 429)")
            return graph.wait_for_query(qid)

        helpers["wait_for_query"] = wait_then_throttle
        with self.assertRaisesRegex(RuntimeError, "refused new audit searches"):
            helpers["fetch_windows"]([self.WIN])
        entry = helpers["_load_manifest"]()[self.key(helpers, self.WIN)]
        self.assertEqual((entry["status"], entry["query_id"]), ("waiting", "q1"))
        self.assertIn("throttled_at", entry)

        rerun, graph2 = self.run_helpers(lambda *a: self.fail("nothing new should be queried"))
        graph2.ranges["q1"] = (*self.WIN, 1)
        rerun["wait_for_query"] = lambda qid: {"status": "succeeded", "id": qid}
        keys, rows = rerun["fetch_windows"]([self.WIN])
        self.assertEqual((graph2.created, len(keys), rows), ([], 1, 1))

    def capped_graph(self, capped_hours, **config):
        helpers, graph = self.run_helpers(lambda *a: "succeeded", **config)

        def wait(qid):
            ws, we, _ = graph.ranges[qid]
            return {"status": "succeeded", "id": qid,
                    "isRecordCountLimitExceeded": (we - ws) > timedelta(hours=capped_hours)}

        helpers["wait_for_query"] = wait
        return helpers, graph

    def test_record_limit_splits_the_window_without_retrying_it(self):
        helpers, graph = self.capped_graph(4, MIN_CHUNK_HOURS=1)
        keys, rows = helpers["fetch_windows"]([self.WIN])
        self.assertEqual(graph.attempts(*self.WIN), 1)
        self.assertEqual(sorted(we - ws for ws, we in graph.created), [timedelta(hours=4)] * 2 + [timedelta(hours=8)])
        self.assertEqual((len(keys), rows), (2, 2))
        manifest = helpers["_load_manifest"]()
        self.assertEqual(manifest[self.key(helpers, self.WIN)]["status"], "split")
        self.assertIn("RecordLimitExceeded", manifest[self.key(helpers, self.WIN)]["error"])
        self.assertEqual(helpers["QUERY_LIMITER"].history, [])

    def test_record_limit_at_the_smallest_window_is_kept_and_flagged(self):
        helpers, graph = self.capped_graph(4, MIN_CHUNK_HOURS=8)
        keys, rows = helpers["fetch_windows"]([self.WIN])
        self.assertEqual((graph.created, len(keys), rows), ([self.WIN], 1, 1))
        entry = helpers["_load_manifest"]()[self.key(helpers, self.WIN)]
        self.assertEqual(entry["status"], "succeeded")
        self.assertTrue(entry["record_limit_exceeded"])

    def test_throttled_run_stops_at_the_budget_instead_of_waiting_for_a_slot(self):
        query = self.query_helpers({"RUN_DEADLINE": time.monotonic() - 1})
        limiter = self.ingester_helpers()["AdaptiveLimiter"](1, 1, check=query["check_budget"])
        limiter.__enter__()
        started = time.monotonic()
        with self.assertRaises(query["BudgetReached"]):
            with limiter:
                self.fail("no slot should be granted")
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(limiter.active, 1)

    def test_limiter_wait_ends_when_the_check_raises(self):
        calls = []

        def check():
            calls.append(1)
            if len(calls) > 1:
                raise RuntimeError("spent")

        limiter = self.ingester_helpers()["AdaptiveLimiter"](1, 1, check=check)
        limiter.__enter__()
        with mock.patch.object(threading.Condition, "wait", lambda self, timeout=None: calls.append(timeout)):
            with self.assertRaisesRegex(RuntimeError, "spent"):
                with limiter:
                    pass
        self.assertEqual(calls, [1, 5, 1])

    def http_response(self, status, retry_after):
        from urllib3.response import HTTPResponse

        return HTTPResponse(body=b"", status=status, headers={"Retry-After": str(retry_after)}, preload_content=False)

    def retry_policy(self, helpers):
        return helpers["_ThrottleAwareRetry"](total=3, status_forcelist=(429, 503), respect_retry_after_header=True)

    def test_long_retry_after_on_429_is_the_daily_limit_not_a_wait(self):
        helpers = self.http_helpers()
        waits = []
        helpers["_wait"] = waits.append
        retry = self.retry_policy(helpers)
        with self.assertRaises(helpers["QueryQuotaReached"]):
            retry.sleep(self.http_response(429, 3600))
        retry.sleep(self.http_response(429, 30))
        retry.sleep(self.http_response(503, 3600))
        self.assertEqual(waits, [30, 3600])
        self.assertEqual(helpers["QUOTA_RETRY_AFTER_SEC"], 300)

    def test_http_retry_waits_stop_at_the_budget(self):
        class Spent(Exception):
            pass

        sleeps, clock = [], [0.0]

        def fake_sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds

        fake_time = type("T", (), {"monotonic": staticmethod(lambda: clock[0]), "sleep": staticmethod(fake_sleep)})
        helpers = self.http_helpers({"time": fake_time})
        helpers["BUDGET_CHECKS"].append(lambda: None)
        helpers["_wait"](12)
        self.assertEqual(sleeps, [5, 5, 2])

        def spent():
            raise Spent()

        helpers["BUDGET_CHECKS"][:] = [spent]
        sleeps.clear()
        with self.assertRaises(Spent):
            self.retry_policy(helpers).sleep(self.http_response(503, 3600))
        self.assertEqual(sleeps, [])

    def test_create_query_pauses_on_a_429_instead_of_retrying_it(self):
        class Resp:
            status_code = 429

            def raise_for_status(self):
                raise AssertionError("a 429 should not reach raise_for_status")

        calls = []
        ns = self.ingester_helpers()
        quota = self.http_helpers()["QueryQuotaReached"]
        transient = {429, 500, 502, 503, 504}
        ns.update({
            "_request": lambda *a, **k: calls.append(k["retry_statuses"]) or Resp(),
            "QueryQuotaReached": quota,
            "_TRANSIENT": transient,
        })
        with self.assertRaises(quota):
            ns["create_query"](*self.WIN)
        self.assertEqual(calls, [transient - {429}])

    def test_http_layer_waits_only_through_the_budget_aware_sleep(self):
        source = cells(INGESTER)[4]
        request = source[source.index("def _request"):]
        self.assertEqual(request.count("_wait(wait)"), 2)
        self.assertNotIn("time.sleep(wait)", request)

    def seed_waiting(self, helpers, created_at, qid="old-q"):
        key = self.key(helpers, self.WIN)
        helpers["_mark_window"](key, "waiting", query_id=qid, query_created_at=created_at.isoformat())
        return key

    def test_old_or_failed_earlier_query_is_replaced_by_a_new_one(self):
        now = datetime.now(timezone.utc)
        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        self.seed_waiting(helpers, now - timedelta(hours=13))
        helpers["fetch_windows"]([self.WIN])
        self.assertEqual(graph.attempts(*self.WIN), 1)

        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        self.seed_waiting(helpers, now - timedelta(hours=1))
        failed = helpers["AuditQueryFailed"]

        def old_query_failed(qid):
            if qid == "old-q":
                raise failed("Query old-q ended with status: failed")
            return graph.wait_for_query(qid)

        helpers["wait_for_query"] = old_query_failed
        keys, _ = helpers["fetch_windows"]([self.WIN])
        self.assertEqual(graph.attempts(*self.WIN), 1)
        entry = helpers["_load_manifest"]()[self.key(helpers, self.WIN)]
        self.assertEqual(entry["status"], "succeeded")
        self.assertEqual(entry["query_id"], "q1")

    def test_resumable_query_id_only_for_recent_unfinished_queries(self):
        resumable = self.checkpoint_helpers()["resumable_query_id"]
        now = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
        recent = (now - timedelta(hours=2)).isoformat()
        self.assertEqual(resumable({"status": "waiting", "query_id": "q", "query_created_at": recent}, now, 12), "q")
        self.assertEqual(resumable({"status": "draining", "query_id": "q", "refreshed_at": recent}, now, 12), "q")
        self.assertIsNone(resumable({"status": "failed", "query_id": "q", "query_created_at": recent}, now, 12))
        self.assertIsNone(resumable({"status": "succeeded", "query_id": "q", "query_created_at": recent}, now, 12))
        self.assertIsNone(resumable({"status": "waiting", "query_created_at": recent}, now, 12))
        self.assertIsNone(resumable({"status": "waiting", "query_id": "q", "query_created_at": recent}, now, 1))
        self.assertIsNone(resumable({"status": "waiting", "query_id": "q", "query_created_at": recent}, now, 0))
        self.assertIsNone(resumable(None, now, 12))

    def test_trailing_window_fetched_recently_is_reused_by_a_retry(self):
        helpers = self.checkpoint_helpers()
        refresh = helpers["should_refresh_window"]
        fresh_after = helpers["trailing_fresh_after"]
        now = datetime(2026, 9, 10, tzinfo=timezone.utc)
        cutoff = now - timedelta(days=7)
        trailing_end = now - timedelta(days=1)
        done = lambda hours_ago: {"status": "succeeded", "completed_at": (now - timedelta(hours=hours_ago)).isoformat()}
        self.assertFalse(refresh(trailing_end, done(1), cutoff, fresh_after(now, 6)))
        self.assertTrue(refresh(trailing_end, done(7), cutoff, fresh_after(now, 6)))
        self.assertTrue(refresh(trailing_end, done(1), cutoff, fresh_after(now, 0)))
        self.assertTrue(refresh(trailing_end, done(1), cutoff))
        self.assertFalse(refresh(cutoff - timedelta(days=1), done(500), cutoff, fresh_after(now, 6)))

    def test_rerun_reuses_succeeded_windows_from_an_older_manifest(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        key = self.key(helpers, self.WIN)
        (SCRATCH / f"win_{key}_0000.jsonl").write_text('{"id":"old"}\n', encoding="utf-8")
        legacy = {
            key: {
                "status": "succeeded",
                "query_id": "old",
                "rows": 1,
                "pages": 1,
                "files": [f"win_{key}_0000.jsonl"],
                "completed_at": "2026-08-26T00:00:00+00:00",
                "window_start": self.WIN[0].isoformat(),
                "window_end": self.WIN[1].isoformat(),
            }
        }
        Path(helpers["MANIFEST"]).write_text(json.dumps(legacy), encoding="utf-8")
        rerun, graph = self.run_helpers(lambda *a: "succeeded")
        keys, rows = rerun["fetch_windows"]([self.WIN, self.NEXT])
        self.assertEqual(graph.created, [self.NEXT])
        self.assertEqual(keys, {key, self.key(rerun, self.NEXT)})
        self.assertEqual(rows, 2)

    def test_non_retryable_error_is_not_retried_but_other_windows_continue(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        original = graph.request
        graph.request = lambda method, url, **kw: (
            FakeResponse({"value": [], "@odata.nextLink": "https://evil.example/x"})
            if graph.ranges[url.split("/queries/")[1].split("/")[0]][0] == self.WIN[0]
            else original(method, url, **kw)
        )
        helpers["_request"] = graph.request
        with self.assertRaisesRegex(RuntimeError, "1 audit window\\(s\\) still failed"):
            helpers["fetch_windows"]([self.WIN, self.NEXT])
        self.assertEqual(graph.attempts(*self.WIN), 1)
        self.assertEqual(helpers["_load_manifest"]()[self.key(helpers, self.NEXT)]["status"], "succeeded")

    def test_authorization_errors_stop_the_run(self):
        class Forbidden(Exception):
            response = type("R", (), {"status_code": 403})()

        def create(ws, we):
            raise Forbidden("403 Forbidden")

        helpers, _ = self.run_helpers(lambda *a: "succeeded", create_query=create)
        with self.assertRaises(Forbidden):
            helpers["fetch_windows"]([self.WIN])

    def test_failures_lower_concurrency_for_the_rest_of_the_run(self):
        active, peak = [0], [0]
        lock = threading.Lock()

        def wait(qid):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time_sleep(0.02)
            with lock:
                active[0] -= 1
            if graph.ranges[qid][2] == 1 and graph.ranges[qid][0] == self.WIN[0]:
                raise failed(f"Query {qid} ended with status: failed")
            return {"status": "succeeded"}

        import time as _time
        time_sleep = _time.sleep
        helpers, graph = self.run_helpers(lambda *a: "succeeded", MAX_CONCURRENT_QUERIES=4)
        failed = helpers["AuditQueryFailed"]
        helpers["wait_for_query"] = wait
        helpers["QUERY_LIMITER"] = helpers["AdaptiveLimiter"](4, 1)
        windows = [
            (self.WIN[0] + timedelta(hours=8 * i), self.WIN[0] + timedelta(hours=8 * (i + 1))) for i in range(12)
        ]
        helpers["fetch_windows"](windows)
        self.assertLessEqual(peak[0], 4)
        self.assertEqual(helpers["QUERY_LIMITER"].limit, 3)
        self.assertEqual([h[:2] for h in helpers["QUERY_LIMITER"].history], [(4, 3)])

    def test_http_429_halves_concurrency_through_the_session_hook(self):
        from urllib3.util.retry import Retry

        ns = exec_named_defs(
            INGESTER, 4, {"THROTTLE_LISTENERS", "_notify_throttle", "_ThrottleAwareRetry"}, {"Retry": Retry}
        )
        limiter = self.ingester_helpers()["AdaptiveLimiter"](6, 1)
        ns["THROTTLE_LISTENERS"][:] = [lambda: limiter.shrink("HTTP 429", halve=True)]
        retry = ns["_ThrottleAwareRetry"](total=3, status_forcelist=(429,), raise_on_status=False)
        response = type("Resp", (), {"status": 429, "headers": {}, "get_redirect_location": lambda self: None})()
        retry = retry.increment("GET", "/x", response=response)
        self.assertIsInstance(retry, ns["_ThrottleAwareRetry"])
        self.assertEqual(limiter.limit, 3)

    def test_incremental_run_refuses_to_skip_an_unrecovered_older_window(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        key = self.key(helpers, self.WIN)
        helpers["manifest"][key] = {
            "status": "failed",
            "window_start": self.WIN[0].isoformat(),
            "window_end": self.WIN[1].isoformat(),
        }
        start = datetime(2026, 9, 3, tzinfo=timezone.utc)
        with self.assertRaisesRegex(RuntimeError, "Rerun with MODE='backfill' first") as caught:
            helpers["assert_no_unrecovered_gaps"](start - timedelta(days=180), start)
        self.assertIn("2026-08-25 00:00 -> 2026-08-25 08:00 UTC", str(caught.exception))
        self.assertIn("ALLOW_UNRECOVERED_GAPS = True", str(caught.exception))
        # Once a later backfill covers the range (even via split parts) the guard passes.
        helpers["manifest"]["v2_part_a"] = {
            "status": "succeeded",
            "window_start": self.WIN[0].isoformat(),
            "window_end": self.WIN[1].isoformat(),
        }
        helpers["assert_no_unrecovered_gaps"](start - timedelta(days=180), start)

    def test_manifest_rejects_split_entry_without_parts(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        Path(helpers["MANIFEST"]).write_text(json.dumps({"k": {"status": "split"}}), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "split but has no valid parts"):
            helpers["_load_manifest"]()

    def test_main_loop_wires_the_gap_guard_limiter_and_throttle_hook(self):
        source = cells(INGESTER)[10]
        self.assertIn("if MODE == 'incremental' and not ALLOW_UNRECOVERED_GAPS:", source)
        self.assertIn(
            "QUERY_LIMITER = AdaptiveLimiter(MAX_CONCURRENT_QUERIES, MIN_CONCURRENT_QUERIES, check=check_budget)", source
        )
        self.assertIn("THROTTLE_LISTENERS[:] = [", source)
        self.assertIn("BUDGET_CHECKS[:] = [check_budget]", source)
        self.assertIn("windows, EMPTY_RECHECK_KEYS = plan_empty_rechecks(windows)", source)
        self.assertIn("ACTIVE_WINDOW_KEYS, total = fetch_windows(windows, EMPTY_RECHECK_KEYS)", source)
        self.assertIn("finally:\n    BUDGET_CHECKS.clear()\n    write_source_status()", source)
        guarded = next(node for node in ast.parse(source).body
                       if isinstance(node, ast.Try) and "write_source_status()" in ast.unparse(node.finalbody))
        for operation in ("plan_audit_sources(windows)", "prefetch_feed(leaf_windows(windows))",
                          "fetch_windows(windows, EMPTY_RECHECK_KEYS)"):
            self.assertIn(operation, ast.unparse(guarded.body))
        self.assertLess(source.index("BUDGET_CHECKS[:] = [check_budget]"),
                        source.index("SOURCE_PLAN.update(plan_audit_sources(windows))"))
        self.assertNotIn("as_completed", source)


class EmptyWindowRecheckTests(unittest.TestCase):
    """Windows that came back empty are queried once more after they leave the look-back."""

    setUp = AuditReliabilityTests.setUp
    tearDown = AuditReliabilityTests.tearDown
    ingester_helpers = AuditReliabilityTests.ingester_helpers
    query_helpers = AuditReliabilityTests.query_helpers
    checkpoint_helpers = AuditReliabilityTests.checkpoint_helpers
    http_helpers = AuditReliabilityTests.http_helpers
    run_helpers = FailedWindowRecoveryTests.run_helpers

    # end_date is 2026-09-10, so with LOOKBACK_DAYS = 7 these windows are past the look-back.
    OLD = (datetime(2026, 8, 25, 0, tzinfo=timezone.utc), datetime(2026, 8, 25, 8, tzinfo=timezone.utc))
    OLDER = (datetime(2026, 8, 24, 16, tzinfo=timezone.utc), datetime(2026, 8, 25, 0, tzinfo=timezone.utc))
    PLAN = [(datetime(2026, 9, 3, 0, tzinfo=timezone.utc), datetime(2026, 9, 3, 8, tzinfo=timezone.utc))]

    def seed_empty(self, helpers, *wins, completed=None):
        for ws, we in wins:
            key = helpers["stable_window_key"](ws, we)
            helpers["manifest"][key] = {
                "status": "succeeded", "window_start": ws.isoformat(), "window_end": we.isoformat(),
                "rows": 0, "pages": 0, "files": [],
                "completed_at": (completed or we + timedelta(hours=1)).isoformat(),
            }
        helpers["_save_manifest"](helpers["manifest"])

    def test_plan_adds_due_empty_windows_before_the_plan_oldest_first(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        self.seed_empty(helpers, self.OLD, self.OLDER)
        windows, recheck = helpers["plan_empty_rechecks"](self.PLAN)
        self.assertEqual(windows, [self.OLDER, self.OLD] + self.PLAN)
        self.assertEqual(recheck, {helpers["stable_window_key"](*w) for w in (self.OLDER, self.OLD)})

    def test_plan_caps_rechecks_and_skips_settled_or_old_windows(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded", EMPTY_RECHECK_MAX=1)
        self.seed_empty(helpers, self.OLD, self.OLDER)
        settled = (datetime(2026, 8, 20, 0, tzinfo=timezone.utc), datetime(2026, 8, 20, 8, tzinfo=timezone.utc))
        self.seed_empty(helpers, settled, completed=settled[1] + timedelta(days=9))
        too_old = (datetime(2026, 7, 1, 0, tzinfo=timezone.utc), datetime(2026, 7, 1, 8, tzinfo=timezone.utc))
        self.seed_empty(helpers, too_old)
        windows, recheck = helpers["plan_empty_rechecks"](self.PLAN)
        self.assertEqual(windows, [self.OLDER] + self.PLAN)
        self.assertEqual(recheck, {helpers["stable_window_key"](*self.OLDER)})

    def test_recheck_is_off_when_empty_recheck_days_is_zero(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded", EMPTY_RECHECK_DAYS=0)
        self.seed_empty(helpers, self.OLD)
        self.assertEqual(helpers["plan_empty_rechecks"](self.PLAN), (self.PLAN, set()))

    def test_due_window_is_queried_again_and_then_settles(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        self.seed_empty(helpers, self.OLD)
        windows, recheck = helpers["plan_empty_rechecks"](self.PLAN)
        keys, rows = helpers["fetch_windows"](windows, recheck)
        self.assertEqual(graph.attempts(*self.OLD), 1)
        self.assertEqual(rows, 2)
        entry = helpers["_load_manifest"]()[helpers["stable_window_key"](*self.OLD)]
        self.assertEqual(entry["rows"], 1)

        # Until the rows are written the window stays in the plan, reused rather than queried again.
        rerun, graph2 = self.run_helpers(lambda *a: self.fail("nothing should be queried"))
        self.assertEqual(rerun["plan_empty_rechecks"](self.PLAN), ([self.OLD] + self.PLAN, set()))
        rerun["clear_recheck_pending"]()
        self.assertEqual(rerun["plan_empty_rechecks"](self.PLAN), (self.PLAN, set()))

    def test_still_empty_window_is_not_queried_a_third_time(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        self.seed_empty(helpers, self.OLD)
        helpers["_request"] = lambda *a, **k: FakeResponse({"value": []})
        windows, recheck = helpers["plan_empty_rechecks"]([])
        self.assertEqual(windows, [self.OLD])
        with contextlib.redirect_stdout(io.StringIO()):
            helpers["fetch_windows"](windows, recheck)
        helpers["clear_recheck_pending"]()
        rerun, _ = self.run_helpers(lambda *a: "succeeded")
        self.assertEqual(rerun["plan_empty_rechecks"]([]), ([], set()))

    def test_run_that_stops_before_the_write_keeps_the_recheck_rows(self):
        helpers, graph = self.run_helpers(lambda *a: "succeeded")
        self.seed_empty(helpers, self.OLD)
        windows, recheck = helpers["plan_empty_rechecks"]([])
        helpers["fetch_windows"](windows, recheck)
        self.assertEqual(graph.attempts(*self.OLD), 1)
        # The run raised (another window throttled) before writing: the retry plans the window again,
        # reuses what it fetched and puts it in the active keys, so the write picks its rows up.
        rerun, graph2 = self.run_helpers(lambda *a: self.fail("nothing should be queried"))
        windows, recheck = rerun["plan_empty_rechecks"]([])
        self.assertEqual((windows, recheck), ([self.OLD], set()))
        keys, _ = rerun["fetch_windows"](windows, recheck)
        self.assertIn(rerun["stable_window_key"](*self.OLD), keys)
        rerun["clear_recheck_pending"]()
        self.assertNotIn("recheck_pending", rerun["_load_manifest"]()[rerun["stable_window_key"](*self.OLD)])

    def test_unfinished_recheck_is_planned_again_and_is_not_a_gap(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        self.seed_empty(helpers, self.OLD)
        helpers["plan_empty_rechecks"]([])
        key = helpers["stable_window_key"](*self.OLD)
        helpers["_mark_window"](key, "failed", error="HTTP 429")
        rerun, graph = self.run_helpers(lambda *a: "succeeded")
        end = rerun["end_date"]
        rerun["assert_no_unrecovered_gaps"](end - timedelta(days=30), end - timedelta(days=7))
        windows, recheck = rerun["plan_empty_rechecks"](self.PLAN)
        self.assertEqual(windows, [self.OLD] + self.PLAN)
        with contextlib.redirect_stdout(io.StringIO()):
            rerun["fetch_windows"](windows, recheck)
        self.assertEqual(graph.attempts(*self.OLD), 1)
        self.assertEqual(rerun["_load_manifest"]()[key]["status"], "succeeded")

    def test_backfill_overwrite_adds_no_older_windows(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded", WRITE_MODE="overwrite")
        self.seed_empty(helpers, self.OLD)
        self.assertEqual(helpers["plan_empty_rechecks"](self.PLAN), (self.PLAN, set()))
        inside, recheck = helpers["plan_empty_rechecks"]([self.OLD] + self.PLAN)
        self.assertEqual(recheck, {helpers["stable_window_key"](*self.OLD)})

    def test_backfill_replace_adds_no_older_windows(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded", WRITE_MODE="replace")
        self.seed_empty(helpers, self.OLD)
        self.assertEqual(helpers["plan_empty_rechecks"](self.PLAN), (self.PLAN, set()))
        inside, recheck = helpers["plan_empty_rechecks"]([self.OLD] + self.PLAN)
        self.assertEqual(recheck, {helpers["stable_window_key"](*self.OLD)})

    def test_flags_are_cleared_after_the_write(self):
        writes = [c for c in cells(INGESTER) if "write_strategy = write_output(flat)" in c]
        self.assertEqual(len(writes), 1)
        self.assertIn("write_strategy = write_output(flat)\nclear_recheck_pending()", writes[0])

    def test_every_window_empty_prints_what_to_check(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded", _request=lambda *a, **k: FakeResponse({"value": []}))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            keys, rows = helpers["fetch_windows"](self.PLAN)
        self.assertEqual(rows, 0)
        text = out.getvalue()
        self.assertIn("Every audit window succeeded, but none had Copilot interaction records", text)
        self.assertIn("AuditLogsQuery.Read.All", text)
        self.assertIn("TENANT_ID", text)

    def test_windows_with_records_print_no_warning(self):
        helpers, _ = self.run_helpers(lambda *a: "succeeded")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            helpers["fetch_windows"](self.PLAN)
        self.assertNotIn("none had Copilot interaction records", out.getvalue())


class AuditTokenPreflightTests(unittest.TestCase):
    """Cell 4 stops before any search when the token can't read Copilot audit records."""

    def test_preflight_runs_after_the_token_and_names_the_fix(self):
        source = cells(INGESTER)[4]
        self.assertIn("def audit_token_problems(token, tenant_id=None):", source)
        after = source[source.index("def get_headers"):]
        self.assertIn("audit_token_problems(", after)
        self.assertIn("raise RuntimeError", after)
        self.assertIn("AuditLogsQuery.Read.All", after)

    def test_config_cell_sets_recheck_defaults(self):
        source = cells(INGESTER)[2]
        self.assertRegex(source, r"EMPTY_RECHECK_DAYS\s+= 30\b")
        self.assertRegex(source, r"EMPTY_RECHECK_MAX\s+= 24\b")


class FakeHttpResponse:
    def __init__(self, payload=None, status=200, text="", headers=None):
        self._payload = payload
        self.status_code = status
        self.text = text or json.dumps(payload)
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests

            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def json(self):
        return self._payload


# A synthetic Copilot interaction in the shapes each source returns. Graph's record is what the
# other two must reproduce.
SYNTHETIC_AUDIT = {
    "Id": "00000000-0000-4000-8000-000000000001", "RecordType": 261, "CreationTime": "2026-09-08T09:15:00Z",
    "Operation": "CopilotInteraction", "OrganizationId": "org-1", "UserType": 0, "UserKey": "user-key-1",
    "Workload": "Copilot", "UserId": "alice@contoso.example", "ClientIP": "203.0.113.5", "ClientRegion": "emea",
    "Version": 1, "CopilotLogVersion": "1.0.0.0", "AppIdentity": "Copilot.MicrosoftCopilot.BizChat",
    "AgentId": "agent-1", "AgentName": "Helper", "AgentPlatform": "CopilotStudio", "PlatformAgentId": "pa-1",
    "CopilotEventData": {
        "AppHost": "Bizchat", "ThreadId": "t-1", "Contexts": [{"Type": "Other"}],
        "ModelTransparencyDetails": [{"ModelName": "gpt-x", "ModelVersion": "1"}],
        "Messages": [{"Id": "m1", "isPrompt": True}, {"Id": "m2", "isPrompt": False}],
        "AccessedResources": [{"Type": "File", "Action": "Read"}],
        "AgentPlatform": "CopilotStudio", "PlatformAgentId": "pa-1",
    },
}


def graph_record(audit=SYNTHETIC_AUDIT):
    return {"id": audit["Id"], "createdDateTime": audit["CreationTime"], "auditLogRecordType": "CopilotInteraction",
            "operation": "CopilotInteraction", "auditData": audit}


def sentinel_row(audit=SYNTHETIC_AUDIT, time_generated=None):
    """The CopilotActivity row for a record, as Log Analytics returns it (dynamic columns as JSON text)."""
    return {
        "TimeGenerated": time_generated or audit["CreationTime"][:-1] + ".1234567Z", "RecordId": audit["Id"],
        "RecordType": "CopilotInteraction", "ActorName": audit["UserId"], "ActorUserId": audit["UserKey"],
        "ActorUserType": "Regular", "OrganizationId": audit["OrganizationId"], "TenantId": "workspace-tenant-column",
        "SrcIpAddr": audit["ClientIP"], "ClientRegion": audit["ClientRegion"], "Workload": audit["Workload"],
        "Version": audit["Version"], "LogVersion": audit["CopilotLogVersion"], "AppIdentity": audit["AppIdentity"],
        "AgentId": audit["AgentId"], "AgentName": audit["AgentName"], "AppHost": "Bizchat",
        "AIModelName": "gpt-x", "AIModelVersion": "1", "LLMEventData": json.dumps(audit["CopilotEventData"]),
    }


class AuditSourceTests(unittest.TestCase):
    """AUDIT_SOURCE: Sentinel's CopilotActivity table and the Management Activity API stage the same rows as Graph."""

    setUp = AuditReliabilityTests.setUp
    tearDown = AuditReliabilityTests.tearDown
    ingester_helpers = AuditReliabilityTests.ingester_helpers
    query_helpers = AuditReliabilityTests.query_helpers
    checkpoint_helpers = AuditReliabilityTests.checkpoint_helpers
    http_helpers = AuditReliabilityTests.http_helpers
    run_helpers = FailedWindowRecoveryTests.run_helpers

    UTC = timezone.utc
    # end_date is 2026-09-10 and LOOKBACK_DAYS = 7: these windows are in the look-back.
    A = (datetime(2026, 9, 8, 0, tzinfo=timezone.utc), datetime(2026, 9, 8, 8, tzinfo=timezone.utc))
    B = (datetime(2026, 9, 8, 8, tzinfo=timezone.utc), datetime(2026, 9, 8, 16, tzinfo=timezone.utc))
    OLD = (datetime(2026, 8, 25, 0, tzinfo=timezone.utc), datetime(2026, 8, 25, 8, tzinfo=timezone.utc))
    NOW = datetime(2026, 9, 10, 0, tzinfo=timezone.utc)

    def source_helpers(self, source="auto", outcome=None, **config):
        ns = {"AUDIT_SOURCE": source, "GRAPH_FOR_HISTORY": False, "TENANT_ID": "tenant-1", "ALLOW_UNRECOVERED_GAPS": False,
              "get_scoped_headers": lambda resource: {"Authorization": "Bearer x"}}
        ns.update(config)
        return self.run_helpers(outcome or (lambda *a: "succeeded"), **ns)

    def key(self, helpers, win):
        return helpers["stable_window_key"](*win)

    # --- choosing a source ---------------------------------------------------------------------
    def test_pick_window_source(self):
        helpers, _ = self.source_helpers()
        pick = helpers["pick_window_source"]
        floor = datetime(2026, 9, 3, 0, 15, tzinfo=self.UTC)
        straddles = (datetime(2026, 9, 2, 16, tzinfo=self.UTC), datetime(2026, 9, 3, 0, 30, tzinfo=self.UTC))
        self.assertEqual(pick(*self.A, "graph", self.A[0], floor), "graph")
        self.assertEqual(pick(*self.A, "auto", self.A[0], floor), "sentinel")
        self.assertEqual(pick(*self.A, "auto", self.B[0], floor), "feed")
        # Auto reads no Graph unless GRAPH_FOR_HISTORY: a window no faster source holds is left out.
        self.assertIsNone(pick(*self.A, "auto", None, None))
        self.assertIsNone(pick(*self.OLD, "auto", None, floor))
        self.assertEqual(pick(*self.A, "auto", None, None, graph_for_history=True), "graph")
        self.assertEqual(pick(*self.OLD, "auto", None, floor, graph_for_history=True), "graph")
        # A window straddling the floor: without Graph the API reads what it holds; with Graph, an
        # overwrite reads it all from Graph and a merge keeps the part an earlier run read.
        self.assertEqual(pick(*straddles, "auto", None, floor), "feed")
        self.assertEqual(pick(*straddles, "auto", None, floor, write_mode="merge"), "feed")
        self.assertEqual(pick(*straddles, "auto", None, floor, True, "overwrite"), "graph")
        self.assertEqual(pick(*straddles, "auto", None, floor, True, "merge"), "feed")
        # A window straddling Sentinel's first record, which the API doesn't hold, is read from Sentinel.
        self.assertEqual(pick(*straddles, "auto", floor - timedelta(hours=4), None), "sentinel")
        self.assertEqual(pick(*straddles, "sentinel", floor - timedelta(hours=4), None), "sentinel")
        self.assertEqual(pick(*straddles, "auto", floor - timedelta(hours=4), None, True), "graph")
        self.assertIsNone(pick(*self.OLD, "sentinel", self.A[0], floor))
        self.assertIsNone(pick(*self.OLD, "feed", None, floor))
        self.assertEqual(pick(*self.A, "feed", self.A[0], floor), "feed")
        # The default, feed, also reads history from Graph when GRAPH_FOR_HISTORY is set.
        self.assertEqual(pick(*self.OLD, "feed", None, floor, graph_for_history=True), "graph")
        self.assertEqual(pick(*straddles, "feed", None, floor, True, "merge"), "feed")

    def test_plan_skips_a_source_that_cannot_be_read_under_auto(self):
        helpers, _ = self.source_helpers()

        def denied(*_a, **_k):
            raise PermissionError("403 Forbidden")

        helpers["sentinel_first_record"] = denied
        helpers["feed_ensure_subscription"] = lambda: None
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            plan = helpers["plan_audit_sources"]([self.A], now=self.NOW)
        self.assertIsNone(plan["sentinel_from"])
        self.assertEqual(plan["feed_floor"], self.NOW - timedelta(days=7) + timedelta(minutes=15))
        self.assertIn("ThreatHunting.Read.All", out.getvalue())

        helpers["AUDIT_SOURCE"] = "sentinel"
        with self.assertRaisesRegex(RuntimeError, "ThreatHunting.Read.All"):
            helpers["plan_audit_sources"]([self.A], now=self.NOW)

    # --- audit_source_status, read by the Load Status step ---------------------------------------
    def http_error(self, status, text=""):
        error = Exception(f"{status} error")
        error.response = type("Response", (), {"status_code": status, "text": text})()
        return error

    def test_source_error_status(self):
        helpers, _ = self.source_helpers()
        status = helpers["source_error_status"]
        self.assertEqual(status(self.http_error(403)), "forbidden")
        self.assertEqual(status(self.http_error(401)), "forbidden")
        self.assertEqual(status(RuntimeError("AADSTS7000215: invalid client secret")), "forbidden")
        # A tenant without Sentinel has no CopilotActivity table: that source is skipped, not a warning.
        missing = self.http_error(400, "Failed to resolve table or column expression named 'CopilotActivity'")
        self.assertEqual(status(missing), "skipped")
        self.assertEqual(status(self.http_error(500, "Internal error")), "error")

    def test_plan_records_each_source_outcome(self):
        helpers, _ = self.source_helpers()
        helpers["sentinel_first_record"] = lambda *a: (_ for _ in ()).throw(
            self.http_error(400, "Failed to resolve table expression named 'CopilotActivity'"))
        helpers["feed_ensure_subscription"] = lambda: self.NOW
        with contextlib.redirect_stdout(io.StringIO()):
            helpers["plan_audit_sources"]([self.A], now=self.NOW)
        # The subscription just started, so the API has nothing yet.
        self.assertEqual(helpers["SOURCE_STATUS"], {"sentinel": "skipped", "feed": "empty"})

        helpers["SOURCE_STATUS"].clear()
        helpers["sentinel_first_record"] = lambda *a: self.A[0]
        with contextlib.redirect_stdout(io.StringIO()):
            helpers["plan_audit_sources"]([self.A], now=self.NOW)
        self.assertEqual(helpers["SOURCE_STATUS"], {"sentinel": "ok"})

        helpers["SOURCE_STATUS"].clear()
        helpers["sentinel_first_record"] = lambda *a: (_ for _ in ()).throw(self.http_error(403))
        helpers["feed_ensure_subscription"] = lambda: None
        with contextlib.redirect_stdout(io.StringIO()):
            helpers["plan_audit_sources"]([self.A], now=self.NOW)
        self.assertEqual(helpers["SOURCE_STATUS"]["sentinel"], "forbidden")

        helpers["SOURCE_STATUS"].clear()
        helpers["AUDIT_SOURCE"] = "graph"
        helpers["plan_audit_sources"]([self.A], now=self.NOW)
        self.assertEqual(helpers["SOURCE_STATUS"], {"graph": "ok"})

    def test_source_status_rows_use_plain_names(self):
        helpers, _ = self.source_helpers()
        rows = helpers["source_status_rows"]({"sentinel": "forbidden", "feed": "ok", "graph": None}, self.NOW)
        self.assertEqual([(r["Source"], r["Status"]) for r in rows],
                         [("Microsoft Sentinel", "forbidden"), ("the Office 365 Management Activity API", "ok")])
        self.assertEqual(helpers["AUDIT_STATUS_TABLE"], "dbo.audit_source_status")

    def test_plan_feed_floor_is_never_before_the_subscription_started(self):
        helpers, _ = self.source_helpers("feed")
        started = datetime(2026, 9, 9, 6, tzinfo=self.UTC)
        helpers["feed_ensure_subscription"] = lambda: started
        with contextlib.redirect_stdout(io.StringIO()):
            plan = helpers["plan_audit_sources"]([self.A], now=self.NOW)
        self.assertEqual(plan["feed_floor"], started)
        # A later run, with the subscription already on, keeps the floor from the state file.
        helpers["feed_ensure_subscription"] = lambda: None
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(helpers["plan_audit_sources"]([self.A], now=self.NOW)["feed_floor"], started)

    # --- record shapes -------------------------------------------------------------------------
    def test_sentinel_row_stages_the_same_row_as_graph(self):
        helpers, _ = self.source_helpers()
        canon = helpers["canonicalize_audit_record"]
        row = {k: helpers["_parse_dynamic"](v) for k, v in sentinel_row().items()}
        staged = helpers["sentinel_record"](row)
        self.assertEqual(canon(staged), canon(graph_record()))
        self.assertNotIn("workspace-tenant-column", json.dumps(staged))

    def test_sentinel_row_without_event_details_fills_them_from_columns(self):
        helpers, _ = self.source_helpers()
        row = sentinel_row()
        row["LLMEventData"] = {"ThreadId": "t-1"}
        audit = helpers["sentinel_record"](row)["auditData"]
        self.assertEqual(audit["CopilotEventData"]["AppHost"], "Bizchat")
        self.assertEqual(audit["CopilotEventData"]["ModelTransparencyDetails"], [{"ModelName": "gpt-x", "ModelVersion": "1"}])
        self.assertEqual(audit["UserType"], 0)
        self.assertEqual(audit["CreationTime"], "2026-09-08T09:15:00Z")

    def test_management_api_record_stages_the_same_row_as_graph(self):
        helpers, _ = self.source_helpers()
        canon = helpers["canonicalize_audit_record"]
        feed = dict(SYNTHETIC_AUDIT, CreationTime="2026-09-08T09:15:00")  # the API leaves off the Z
        self.assertEqual(canon(helpers["feed_record"](feed)), canon(graph_record()))

    def test_graph_odata_annotations_preserve_cross_source_identity(self):
        helpers, _ = self.source_helpers()
        canon = helpers["canonicalize_audit_record"]
        annotated = json.loads(json.dumps(SYNTHETIC_AUDIT))
        annotated.update({"@odata.type": "#microsoft.graph.auditData", "RecordType@odata.type": "#Int64"})
        annotated["CopilotEventData"].update({
            "@odata.type": "#microsoft.graph.copilotEventData",
            "Messages@odata.type": "#Collection(microsoft.graph.copilotMessage)",
            "AccessedResources@odata.type": "#Collection(microsoft.graph.copilotResource)",
        })
        graph = canon(graph_record(annotated))
        feed = canon(helpers["feed_record"](SYNTHETIC_AUDIT))
        self.assertNotEqual(graph["AuditData"], feed["AuditData"], "raw OData metadata is retained")
        self.assertEqual(graph["SourceRecordKey"], feed["SourceRecordKey"])
        graph_event = json.loads(graph["AuditData"])["CopilotEventData"]
        feed_event = json.loads(feed["AuditData"])["CopilotEventData"]
        for array in ("Messages", "AccessedResources"):
            self.assertEqual([x["_StableKey"] for x in graph_event[array]],
                             [x["_StableKey"] for x in feed_event[array]])

    def test_bucket_feed_records_by_window(self):
        helpers, _ = self.source_helpers()
        recs = [{"createdDateTime": t} for t in
                ("2026-09-08T00:00:00Z", "2026-09-08T07:59:59Z", "2026-09-08T08:00:00Z", "2026-09-08T16:00:00Z", None)]
        buckets = helpers["bucket_feed_records"](recs, [self.B, self.A])
        self.assertEqual(len(buckets[self.key(helpers, self.A)]), 2)
        self.assertEqual(len(buckets[self.key(helpers, self.B)]), 1)

    # --- Sentinel queries ----------------------------------------------------------------------
    def test_sentinel_page_query_escapes_values_and_validates_names(self):
        helpers, _ = self.source_helpers()
        query = helpers["sentinel_page_query"](*self.A, after=("2026-09-08T01:02:03.1234567Z", 'a"b\\c'), rows=5)
        self.assertIn("CopilotActivity | where TimeGenerated >= datetime(2026-09-08T00:00:00.000000Z)", query)
        self.assertIn('strcmp(tostring(RecordId), "a\\"b\\\\c") > 0', query)
        self.assertIn("TimeGenerated == datetime(2026-09-08T01:02:03.1234567Z)", query)
        self.assertTrue(query.endswith("| sort by TimeGenerated asc, _RecordId asc | take 5 | project-away _RecordId"))
        self.assertNotIn("| top ", query)
        with self.assertRaises(ValueError):
            helpers["sentinel_page_query"](*self.A, after=("2026-09-08) | take 1 //", "x"))
        helpers["SENTINEL_TABLE"] = "CopilotActivity | take 1"
        with self.assertRaises(ValueError):
            helpers["sentinel_page_query"](*self.A)

    def hunting(self, rows_by_window, calls, size_limit_hours=None):
        """A fake advanced hunting API over CopilotActivity rows, honouring the window and the page cursor."""

        def request(method, url, json=None, **_kwargs):
            self.assertEqual((method, url), ("POST", "https://graph.microsoft.com/v1.0/security/runHuntingQuery"))
            query = json["Query"]
            calls.append(query)
            start, end = [datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=self.UTC)
                          for s in json["Timespan"].split("/")]
            if size_limit_hours and end - start > timedelta(hours=size_limit_hours, seconds=1):
                return FakeHttpResponse({"error": {}}, 400, "Query result exceeded the size limit")
            rows = [r for r in rows_by_window if start <= datetime.strptime(r["TimeGenerated"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=self.UTC) < end]
            rows.sort(key=lambda r: (r["TimeGenerated"], r["RecordId"]))
            if "strcmp(" in query:
                cursor_t = query.split("TimeGenerated == datetime(")[1].split(")")[0]
                cursor_id = query.split('strcmp(tostring(RecordId), "')[1].split('"')[0]
                rows = [r for r in rows if (r["TimeGenerated"], r["RecordId"]) > (cursor_t, cursor_id)]
            top = int(query.rsplit("| take ", 1)[1].split(" ")[0])
            return FakeHttpResponse({"results": rows[:top]})

        return request

    def rows_in(self, win, count):
        out = []
        for i in range(count):
            t = win[0] + timedelta(minutes=10 * i)
            audit = dict(SYNTHETIC_AUDIT, Id=f"00000000-0000-4000-8000-{i:012d}-{win[0]:%H}", CreationTime=f"{t:%Y-%m-%dT%H:%M:%S}Z")
            out.append(sentinel_row(audit, time_generated=f"{t:%Y-%m-%dT%H:%M:%S}.0000000Z"))
        return out

    def test_sentinel_window_is_read_in_pages_and_never_queries_graph(self):
        calls = []
        rows = self.rows_in(self.A, 5)
        helpers, graph = self.source_helpers(SENTINEL_PAGE_ROWS=2)
        helpers["_request"] = self.hunting(rows, calls)
        helpers["SOURCE_PLAN"].update(sentinel_from=self.A[0])
        with contextlib.redirect_stdout(io.StringIO()):
            keys, staged = helpers["fetch_windows"]([self.A])
        self.assertEqual(graph.created, [])
        self.assertEqual(staged, 5)
        self.assertEqual(len(calls), 3)
        entry = helpers["_load_manifest"]()[self.key(helpers, self.A)]
        self.assertEqual((entry["status"], entry["source"], entry["rows"], entry["pages"]), ("succeeded", "sentinel", 5, 3))
        files = helpers["list_active_stage_files"](str(SCRATCH), keys)
        ids = [json.loads(line)["RecordId"] for f in files for line in Path(f).read_text(encoding="utf-8").splitlines()]
        self.assertEqual(sorted(ids), sorted(r["RecordId"] for r in rows))

    def test_sentinel_size_limit_splits_the_window(self):
        calls = []
        helpers, graph = self.source_helpers()
        helpers["_request"] = self.hunting(self.rows_in(self.A, 6), calls, size_limit_hours=4)
        helpers["SOURCE_PLAN"].update(sentinel_from=self.A[0])
        with contextlib.redirect_stdout(io.StringIO()):
            keys, staged = helpers["fetch_windows"]([self.A])
        self.assertEqual(graph.created, [])
        self.assertEqual((len(keys), staged), (2, 6))
        self.assertEqual(helpers["_load_manifest"]()[self.key(helpers, self.A)]["status"], "split")

    # --- the Management Activity API -----------------------------------------------------------
    def feed_api(self, helpers, blobs, downloads):
        listed = []
        helpers["feed_list_content"] = lambda start, end: listed.append((start, end)) or [dict(b) for b in blobs]
        helpers["feed_download"] = lambda uri: downloads.append(uri) or [dict(r) for r in blobs_by_uri[uri]]
        blobs_by_uri = {}
        return listed, blobs_by_uri

    def feed_rec(self, win, minute, n):
        t = win[0] + timedelta(minutes=minute)
        return dict(SYNTHETIC_AUDIT, Id=f"00000000-0000-4000-8000-{n:012d}", CreationTime=f"{t:%Y-%m-%dT%H:%M:%S}")

    def test_management_api_fills_windows_in_full_then_tops_them_up(self):
        helpers, graph = self.source_helpers("feed")
        helpers["SOURCE_PLAN"].update(feed_floor=self.NOW - timedelta(days=7) + timedelta(minutes=15))
        downloads = []
        blobs = [{"contentId": "c1", "contentUri": "u1", "contentCreated": "2026-09-08T17:00:00.000Z"}]
        listed, by_uri = self.feed_api(helpers, blobs, downloads)
        outside = dict(SYNTHETIC_AUDIT, Id="outside", CreationTime="2026-09-07T12:00:00")
        by_uri["u1"] = [self.feed_rec(self.A, 5, 1), self.feed_rec(self.A, 65, 2), self.feed_rec(self.B, 5, 3), outside]
        with contextlib.redirect_stdout(io.StringIO()):
            filled = helpers["prefetch_feed"]([self.A, self.B], now=self.NOW)
        self.assertEqual(filled, {self.key(helpers, self.A), self.key(helpers, self.B)})
        manifest = helpers["_load_manifest"]()
        self.assertEqual([manifest[self.key(helpers, w)]["rows"] for w in (self.A, self.B)], [2, 1])
        self.assertEqual({manifest[self.key(helpers, w)]["source"] for w in (self.A, self.B)}, {"feed"})
        self.assertEqual(downloads, ["u1"])

        # The next run reads only new content: c1 is not downloaded again, c2's record tops up window B.
        later = self.NOW + timedelta(hours=2)
        blobs.append({"contentId": "c2", "contentUri": "u2", "contentCreated": "2026-09-10T01:00:00.000Z"})
        by_uri["u2"] = [self.feed_rec(self.B, 30, 4)]
        downloads.clear()
        with contextlib.redirect_stdout(io.StringIO()):
            helpers["prefetch_feed"]([self.A, self.B], now=later)
        self.assertEqual(downloads, ["u2"])
        self.assertEqual(listed[-1][0], self.NOW - timedelta(hours=6))
        manifest = helpers["_load_manifest"]()
        self.assertEqual([manifest[self.key(helpers, w)]["rows"] for w in (self.A, self.B)], [2, 2])
        b_files = helpers["list_window_files"](str(SCRATCH), self.key(helpers, self.B))
        self.assertEqual(len(b_files), 2)
        state = json.loads((SCRATCH / "_feed_state.json").read_text(encoding="utf-8"))
        self.assertEqual(set(state["seen"]), {"c1", "c2"})
        self.assertEqual(state["listed_through"], f"{later:%Y-%m-%dT%H:%M:%S}Z")

        # fetch_windows then queries nothing for them.
        helpers["PREFETCHED_KEYS"].update({self.key(helpers, self.A), self.key(helpers, self.B)})
        with contextlib.redirect_stdout(io.StringIO()):
            keys, rows = helpers["fetch_windows"]([self.A, self.B])
        self.assertEqual(graph.created, [])
        self.assertEqual(rows, 4)

    def test_window_read_in_full_again_rereads_content_seen_before(self):
        helpers, _ = self.source_helpers("feed")
        helpers["SOURCE_PLAN"].update(feed_floor=self.NOW - timedelta(days=7) + timedelta(minutes=15))
        downloads = []
        blobs = [{"contentId": "c1", "contentUri": "u1", "contentCreated": "2026-09-08T17:00:00.000Z"}]
        _, by_uri = self.feed_api(helpers, blobs, downloads)
        by_uri["u1"] = [self.feed_rec(self.A, 5, 1), self.feed_rec(self.B, 5, 2)]
        with contextlib.redirect_stdout(io.StringIO()):
            helpers["prefetch_feed"]([self.A, self.B], now=self.NOW)
        # Window A's files are lost, so it is read in full; B already holds c1 and keeps its single row.
        helpers["purge_window_files"](str(SCRATCH), self.key(helpers, self.A), include_partial=True)
        downloads.clear()
        with contextlib.redirect_stdout(io.StringIO()):
            helpers["prefetch_feed"]([self.A, self.B], now=self.NOW + timedelta(hours=1))
        self.assertEqual(downloads, ["u1"])
        manifest = helpers["_load_manifest"]()
        self.assertEqual([manifest[self.key(helpers, w)]["rows"] for w in (self.A, self.B)], [1, 1])

    def test_feed_urls_stay_on_the_api_host(self):
        helpers, _ = self.source_helpers("feed")
        self.assertEqual(
            helpers["_feed_url"]("subscriptions/content", contentType="Audit.General", startTime="2026-09-08T00:00:00"),
            "https://manage.office.com/api/v1.0/tenant-1/activity/feed/subscriptions/content"
            "?contentType=Audit.General&startTime=2026-09-08T00:00:00",
        )
        with self.assertRaisesRegex(RuntimeError, "another host"):
            helpers["_check_feed_url"]("https://attacker.example/api/v1.0/x")

    def test_feed_download_keeps_only_copilot_interactions(self):
        helpers, _ = self.source_helpers("feed")
        helpers["_request"] = lambda *a, **k: FakeHttpResponse(
            [{"Id": "a", "RecordType": 261}, {"Id": "b", "RecordType": "261"}, {"Id": "c", "RecordType": 310}])
        recs = helpers["feed_download"]("https://manage.office.com/api/v1.0/tenant-1/activity/feed/audit/x")
        self.assertEqual([r["Id"] for r in recs], ["a", "b"])

    def test_expired_feed_content_does_not_advance_the_checkpoint(self):
        helpers, _ = self.source_helpers("feed")
        helpers["SOURCE_PLAN"].update(feed_floor=self.NOW - timedelta(days=7))
        blobs = [{"contentId": "expired", "contentUri": "u1", "contentCreated": self.NOW.isoformat()}]
        helpers["feed_list_content"] = lambda *a: blobs

        def expired(_uri):
            raise self.http_error(404)

        helpers["feed_download"] = expired
        with self.assertRaisesRegex(helpers["AuditQueryFailed"], "checkpoint was not advanced"):
            helpers["prefetch_feed"]([self.A], now=self.NOW)
        self.assertFalse((SCRATCH / "_feed_state.json").exists())
        self.assertEqual(helpers["_load_manifest"](), {})

    def test_feed_content_list_overlap_downloads_each_blob_once(self):
        helpers, _ = self.source_helpers("feed")
        helpers["SOURCE_PLAN"].update(feed_floor=self.NOW - timedelta(days=7))
        blob = {"contentId": "c1", "contentUri": "u1", "contentCreated": self.NOW.isoformat()}
        downloads = []
        _, by_uri = self.feed_api(helpers, [blob, blob], downloads)
        by_uri["u1"] = [self.feed_rec(self.A, 1, 1)]
        with contextlib.redirect_stdout(io.StringIO()):
            helpers["prefetch_feed"]([self.A], now=self.NOW)
        self.assertEqual(downloads, ["u1"])
        self.assertEqual(helpers["_load_manifest"]()[self.key(helpers, self.A)]["rows"], 1)

    def test_sentinel_invalid_results_are_not_successful_empty_windows(self):
        helpers, _ = self.source_helpers()
        for via, payload in [
            ("hunting", {}), ("hunting", {"results": [None]}),
            ("loganalytics", {"tables": []}),
            ("loganalytics", {"tables": [{"columns": [{"name": "RecordId"}], "rows": [[]]}]}),
        ]:
            with self.subTest(via=via, payload=payload):
                helpers["SENTINEL_QUERY_VIA"] = via
                helpers["SENTINEL_WORKSPACE_ID"] = "workspace-1"
                helpers["_request"] = lambda *a, **k: FakeHttpResponse(payload)
                with self.assertRaises(helpers["AuditQueryFailed"]):
                    helpers["run_sentinel_query"]("query", *self.A)

    def test_loganalytics_maps_dynamic_columns_and_rejects_partial_results(self):
        helpers, _ = self.source_helpers(SENTINEL_QUERY_VIA="loganalytics", SENTINEL_WORKSPACE_ID="workspace-1")
        raw = sentinel_row()
        helpers["_request"] = lambda *a, **k: FakeHttpResponse(
            {"tables": [{"columns": [{"name": name} for name in raw], "rows": [list(raw.values())]}]})
        rows = helpers["run_sentinel_query"]("query", *self.A)
        self.assertIsInstance(rows[0]["LLMEventData"], dict)
        self.assertEqual(rows[0]["RecordId"], raw["RecordId"])
        helpers["_request"] = lambda *a, **k: FakeHttpResponse(
            {"tables": [], "error": {"code": "PartialError", "message": "Query result size exceeded"}})
        with self.assertRaises(helpers["RecordLimitExceeded"]):
            helpers["run_sentinel_query"]("query", *self.A)

    # --- gaps and fallbacks --------------------------------------------------------------------
    def test_window_no_source_holds_stops_the_run_unless_gaps_are_allowed(self):
        helpers, graph = self.source_helpers("sentinel")
        helpers["SOURCE_PLAN"].update(sentinel_from=self.A[0])
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "not held by any enabled source"):
            helpers["fetch_windows"]([self.OLD])
        self.assertEqual(graph.created, [])

        helpers, graph = self.source_helpers("sentinel", ALLOW_UNRECOVERED_GAPS=True)
        helpers["SOURCE_PLAN"].update(sentinel_from=self.A[0])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            helpers["fetch_windows"]([self.OLD])
        self.assertIn("left empty", out.getvalue())

    def test_auto_with_graph_for_history_reads_windows_no_faster_source_holds_from_graph(self):
        helpers, graph = self.source_helpers("auto", GRAPH_FOR_HISTORY=True)
        helpers["SOURCE_PLAN"].update(feed_floor=self.NOW - timedelta(days=7) + timedelta(minutes=15))
        # Window A was meant for the API, but the API couldn't be read (not prefetched): Graph reads it.
        with contextlib.redirect_stdout(io.StringIO()):
            keys, rows = helpers["fetch_windows"]([self.OLD, self.A])
        self.assertEqual(sorted(graph.created), sorted([self.OLD, self.A]))
        entry = helpers["_load_manifest"]()[self.key(helpers, self.OLD)]
        self.assertEqual(entry["source"], "graph")

    def test_auto_leaves_out_windows_no_source_holds_and_keeps_history(self):
        helpers, _ = self.source_helpers("auto")
        floor = self.NOW - timedelta(days=7) + timedelta(minutes=15)
        straddles = (floor - timedelta(hours=4), floor + timedelta(hours=4))
        helpers["SOURCE_PLAN"].update(feed_floor=floor)
        drop = helpers["drop_out_of_reach"]
        # The first load: windows older than the API's 7 days are left out, and an overwrite merges,
        # so the history already in the table isn't deleted.
        self.assertEqual(drop([self.OLD, self.A], "overwrite"), ([self.A], [self.OLD], "merge"))
        self.assertEqual(drop([self.OLD, self.A], "merge"), ([self.A], [self.OLD], "merge"))
        # A window the API holds only part of is read, but the part before the floor is kept too.
        self.assertEqual(drop([straddles, self.A], "overwrite"), ([straddles, self.A], [], "merge"))
        # Every window held: an overwrite stays an overwrite.
        self.assertEqual(drop([self.A, self.B], "overwrite"), ([self.A, self.B], [], "overwrite"))
        # Graph reads history: nothing is left out.
        helpers["GRAPH_FOR_HISTORY"] = True
        self.assertEqual(drop([self.OLD, self.A], "overwrite"), ([self.OLD, self.A], [], "overwrite"))
        helpers["GRAPH_FOR_HISTORY"] = False
        helpers["AUDIT_SOURCE"] = "graph"
        self.assertEqual(drop([self.OLD, self.A], "overwrite"), ([self.OLD, self.A], [], "overwrite"))

    def test_partial_backfill_merges_existing_rows(self):
        helpers, _ = self.source_helpers("feed", WRITE_MODE="replace")
        floor = self.NOW - timedelta(days=7) + timedelta(minutes=15)
        straddles = (floor - timedelta(hours=4), floor + timedelta(hours=4))
        helpers["SOURCE_PLAN"].update(feed_floor=floor)
        drop = helpers["drop_out_of_reach"]

        self.assertEqual(drop([self.OLD, self.A], "replace"), ([self.A], [self.OLD], "merge"))
        self.assertEqual(drop([straddles, self.A], "replace"), ([straddles, self.A], [], "merge"))
        self.assertEqual(drop([self.A, self.B], "replace"), ([self.A, self.B], [], "replace"))
        helpers["GRAPH_FOR_HISTORY"] = True
        self.assertEqual(drop([self.OLD, self.A], "replace"), ([self.OLD, self.A], [], "replace"))

    def test_auto_stops_when_the_management_api_cannot_be_read_without_graph(self):
        helpers, _ = self.source_helpers("auto")
        helpers["sentinel_first_record"] = lambda *_a, **_k: None

        def denied():
            raise PermissionError("403 Forbidden")

        helpers["feed_ensure_subscription"] = denied
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "ActivityFeed.Read"):
            helpers["plan_audit_sources"]([self.A], now=self.NOW)
        # With Graph reading history, the API's windows go to Graph instead.
        helpers["GRAPH_FOR_HISTORY"] = True
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            plan = helpers["plan_audit_sources"]([self.A], now=self.NOW)
        self.assertIsNone(plan["feed_floor"])
        self.assertIn("read from Graph instead", out.getvalue())

    def test_main_block_leaves_out_unheld_windows_before_any_query(self):
        main = cells(INGESTER)[10]
        drop = main.index("drop_out_of_reach(windows, WRITE_MODE)")
        self.assertLess(main.index("plan_audit_sources(windows)"), drop)
        self.assertLess(drop, main.index("plan_empty_rechecks(windows)", drop))
        self.assertIn("if not GRAPH_FOR_HISTORY:", main)

    def test_feed_with_graph_for_history_loads_older_windows_from_graph(self):
        helpers, graph = self.source_helpers("feed")
        floor = self.NOW - timedelta(days=7) + timedelta(minutes=15)
        helpers["SOURCE_PLAN"].update(feed_floor=floor)
        drop = helpers["drop_out_of_reach"]
        self.assertEqual(drop([self.OLD, self.A], "overwrite"), ([self.A], [self.OLD], "merge"))
        helpers["GRAPH_FOR_HISTORY"] = True
        self.assertEqual(drop([self.OLD, self.A], "overwrite"), ([self.OLD, self.A], [], "overwrite"))
        self.assertEqual(helpers["_window_fetch_source"](*self.OLD), "graph")

    def test_feed_falls_back_to_graph_only_with_graph_for_history(self):
        helpers, _ = self.source_helpers("feed")

        def denied():
            raise PermissionError("403 Forbidden")

        helpers["feed_ensure_subscription"] = denied
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "ActivityFeed.Read"):
            helpers["plan_audit_sources"]([self.A], now=self.NOW)
        helpers["GRAPH_FOR_HISTORY"] = True
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            plan = helpers["plan_audit_sources"]([self.A], now=self.NOW)
        self.assertIsNone(plan["feed_floor"])
        self.assertIn("read from Graph instead", out.getvalue())

    def test_empty_windows_are_rechecked_only_in_sentinel(self):
        helpers, _ = self.source_helpers("auto")
        key = self.key(helpers, self.OLD)
        helpers["manifest"][key] = {
            "status": "succeeded", "window_start": self.OLD[0].isoformat(), "window_end": self.OLD[1].isoformat(),
            "rows": 0, "pages": 0, "files": [], "completed_at": (self.OLD[1] + timedelta(hours=1)).isoformat(),
        }
        helpers["_save_manifest"](helpers["manifest"])
        plan = [self.A]
        self.assertEqual(helpers["plan_empty_rechecks"](plan), (plan, set()))
        helpers["SOURCE_PLAN"].update(sentinel_from=self.OLD[0])
        self.assertEqual(helpers["plan_empty_rechecks"](plan), ([self.OLD] + plan, {key}))

    def test_config_and_auth_cells_offer_the_sources(self):
        config, auth = cells(INGESTER)[2], cells(INGESTER)[4]
        self.assertRegex(config, r"AUDIT_SOURCE\s+= 'feed'")
        self.assertRegex(config, r"GRAPH_FOR_HISTORY\s+= False")
        self.assertIn("def get_scoped_headers(resource", auth)
        self.assertIn("'graph', 'auto', 'sentinel', 'feed'", auth)


if __name__ == "__main__":
    unittest.main()
