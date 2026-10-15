"""Refresh Model notebook: syncs the Lakehouse SQL endpoints before refreshing the semantic model."""
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "fabric" / "notebooks" / "ValueLens_Refresh_Model.ipynb"
WS = "00000000-0000-0000-0000-0000000000aa"
FABRIC = f"https://api.fabric.microsoft.com/v1/workspaces/{WS}"


class Response:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.content = b"" if body is None else json.dumps(body).encode()
        self.text = self.content.decode()

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeApi:
    """Answers the Fabric and Power BI calls the notebook makes and records them in order."""

    def __init__(self, endpoints, sync=None, refresh=None, history=None):
        self.endpoints = endpoints
        self.sync = sync or (lambda endpoint_id: Response(200, {"value": []}))
        self.refresh = refresh or {"status": "Completed"}
        self.history = [{"status": "Completed"}] if history is None else history
        self.calls = []
        self.refresh_bodies = []

    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append(("GET", url))
        if url == f"{FABRIC}/sqlEndpoints":
            return self.endpoints if isinstance(self.endpoints, Response) else Response(200, {"value": self.endpoints})
        if url.startswith("https://operations/"):
            return Response(200, {"status": "Succeeded"})
        if url.endswith("/refreshes"):
            return Response(200, {"value": self.history})
        return Response(200, self.refresh)

    def post(self, url, headers=None, json=None, timeout=None):
        self.calls.append(("POST", url))
        if url.endswith("/refreshMetadata"):
            return self.sync(url.split("/")[-2])
        self.refresh_bodies.append(json)
        return Response(202, headers={"Location": url + "/r1"})


class AuditState:
    def __init__(self, pending="generation-2", completed="generation-1"):
        self.properties = {"valuelens.audit_data_version": pending,
                           "valuelens.audit_refreshed.model": completed}
        self.acknowledgements = []

    def sql(self, statement):
        if statement.startswith("DESCRIBE DETAIL"):
            return types.SimpleNamespace(collect=lambda: [{"properties": dict(self.properties)}])
        self.acknowledgements.append(statement)
        return None


def run_notebook(api, audit=None, model="model"):
    cells = ["".join(c["source"]) for c in json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"] if c["cell_type"] == "code"]
    notebookutils = types.ModuleType("notebookutils")
    notebookutils.credentials = types.SimpleNamespace(getToken=lambda audience: "token")
    requests = types.ModuleType("requests")
    requests.get, requests.post = api.get, api.post
    scope = {}
    with mock.patch.dict(sys.modules, {"notebookutils": notebookutils, "requests": requests}), \
            mock.patch("time.sleep"), mock.patch("builtins.print"):
        exec(cells[0], scope)
        scope.update(WORKSPACE_ID=WS, SEMANTIC_MODEL_ID=model,
                     CHECK_AUDIT_STATE=audit is not None, spark=audit)
        exec(cells[1], scope)
    return [(method, url) for method, url in api.calls if method == "POST"]


class RefreshModelTests(unittest.TestCase):
    def test_notebook_is_clean(self):
        notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])
                compile("".join(cell["source"]), str(NOTEBOOK), "exec")

    def test_syncs_sql_endpoints_before_refreshing(self):
        api = FakeApi([
            {"id": "lh", "displayName": "Analytics_Hub_LH"},
            {"id": "staging", "displayName": "StagingLakehouseForDataflows_20260101"},
        ])
        posts = run_notebook(api)
        self.assertEqual(posts[0], ("POST", f"{FABRIC}/sqlEndpoints/lh/refreshMetadata"))
        self.assertTrue(posts[1][1].endswith("/datasets/model/refreshes"))
        self.assertNotIn(("POST", f"{FABRIC}/sqlEndpoints/staging/refreshMetadata"), posts)

    def test_waits_for_a_long_running_sync(self):
        api = FakeApi([{"id": "lh", "displayName": "LH"}],
                      sync=lambda _: Response(202, headers={"Location": "https://operations/1", "Retry-After": "1"}))
        run_notebook(api)
        self.assertIn(("GET", "https://operations/1"), api.calls)
        poll = api.calls.index(("GET", "https://operations/1"))
        refresh = next(i for i, (m, u) in enumerate(api.calls) if m == "POST" and u.endswith("/refreshes"))
        self.assertLess(poll, refresh)

    def test_a_failed_sync_does_not_stop_the_refresh(self):
        for api in (FakeApi(Response(403, {"error": "Forbidden"})),
                    FakeApi([{"id": "lh", "displayName": "LH"}], sync=lambda _: Response(500, {"error": "boom"}))):
            with self.subTest(calls=api.endpoints):
                posts = run_notebook(api)
                self.assertTrue(posts[-1][1].endswith("/datasets/model/refreshes"))

    def test_a_completed_refresh_with_a_warning_fails(self):
        # A calculated table whose DAX does not parse is only a Warning, and the refresh still
        # ends Completed. Nothing that depends on it is calculated, so the notebook must fail.
        warning = {"type": "Warning", "code": "0x413A0013",
                   "message": "The syntax for 'LastDate' is incorrect."}
        for body in ({"status": "Completed", "messages": [warning]},
                     {"status": "Completed", "messages": [dict(warning, type="Error")]},
                     {"status": "Failed", "messages": [{"message": "boom"}]}):
            with self.subTest(body=body):
                with self.assertRaises(RuntimeError) as raised:
                    run_notebook(FakeApi([], refresh=body))
                self.assertIn(body["messages"][0]["message"], str(raised.exception))

    def test_a_completed_refresh_with_only_information_messages_passes(self):
        info = {"type": "Information", "message": "Partition processed."}
        posts = run_notebook(FakeApi([], refresh={"status": "Completed", "messages": [info]}))
        self.assertTrue(posts[-1][1].endswith("/datasets/model/refreshes"))

    def test_pending_history_reloads_audit_partitions_and_acknowledges_after_success(self):
        state, api = AuditState(), FakeApi([])
        run_notebook(api, state)
        self.assertEqual(len(api.refresh_bodies), 2)
        self.assertFalse(api.refresh_bodies[-1]["applyRefreshPolicy"])
        self.assertEqual(api.refresh_bodies[-1]["objects"], [{"table": "Chat + Agent Interactions (Audit Logs)"}])
        self.assertEqual(len(state.acknowledgements), 1)
        self.assertIn("'valuelens.audit_refreshed.model' = 'generation-2'", state.acknowledgements[0])
        self.assertNotIn("audit_data_version", state.acknowledgements[0])

    def test_acknowledged_history_does_not_force_another_full_refresh(self):
        state, api = AuditState(completed="generation-2"), FakeApi([])
        run_notebook(api, state)
        self.assertEqual(len(api.refresh_bodies), 1)
        self.assertEqual(state.acknowledgements, [])

    def test_failed_refresh_keeps_history_pending_for_retry(self):
        state = AuditState()
        with self.assertRaises(RuntimeError):
            run_notebook(FakeApi([], refresh={"status": "Failed"}), state)
        self.assertEqual(state.acknowledgements, [])
        api = FakeApi([])
        run_notebook(api, state)
        self.assertEqual(len(api.refresh_bodies), 2)

    def test_missing_requested_audit_state_is_an_error_not_success(self):
        state = AuditState()
        state.sql = mock.Mock(side_effect=RuntimeError("default lakehouse unavailable"))
        api = FakeApi([])
        with self.assertRaisesRegex(RuntimeError, "default lakehouse unavailable"):
            run_notebook(api, state)
        self.assertEqual(api.refresh_bodies, [])

    def test_acknowledgement_cannot_clear_a_concurrent_processor_generation(self):
        state, api = AuditState(), FakeApi([])
        original_post = api.post

        def post(*args, **kwargs):
            result = original_post(*args, **kwargs)
            state.properties["valuelens.audit_data_version"] = "generation-3"
            return result

        api.post = post
        run_notebook(api, state)
        self.assertIn("'generation-2'", state.acknowledgements[0])
        self.assertEqual(state.properties["valuelens.audit_data_version"], "generation-3")

    def test_committed_token_is_captured_before_sql_endpoint_sync(self):
        state = AuditState()

        def sync(_):
            state.properties["valuelens.audit_data_version"] = "generation-3"
            return Response(200, {"value": []})

        api = FakeApi([{"id": "lh"}], sync=sync)
        run_notebook(api, state)
        self.assertIn("'generation-2'", state.acknowledgements[0])
        self.assertEqual(state.properties["valuelens.audit_data_version"], "generation-3")

    def test_pending_token_always_requires_explicit_all_partition_success(self):
        for history in ([], [{"status": "Failed"}]):
            with self.subTest(history=history):
                state, api = AuditState(), FakeApi([], history=history)
                run_notebook(api, state)
                self.assertEqual(len(api.refresh_bodies), 2)
                self.assertFalse(api.refresh_bodies[-1]["applyRefreshPolicy"])
                self.assertEqual(len(state.acknowledgements), 1)

    def test_failed_all_partition_refresh_does_not_acknowledge_first_refresh(self):
        state, api = AuditState(), FakeApi([], history=[])
        original_get = api.get

        def get(*args, **kwargs):
            response = original_get(*args, **kwargs)
            if len(api.refresh_bodies) == 2:
                return Response(200, {"status": "Failed"})
            return response

        api.get = get
        with self.assertRaisesRegex(RuntimeError, "Failed"):
            run_notebook(api, state)
        self.assertEqual(state.acknowledgements, [])


if __name__ == "__main__":
    unittest.main()
