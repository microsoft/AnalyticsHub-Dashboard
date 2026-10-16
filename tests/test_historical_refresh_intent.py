"""Real notebook planner/publisher/consumer control flow with injected storage, not live Fabric."""
import ast
from contextlib import contextmanager
import datetime
import json
import re
import subprocess
import sys
from types import SimpleNamespace
import uuid

import pytest

from test_incremental_processing import _processor_code
from test_refresh_model import FakeApi, run_notebook


STATE = "valuelens.processor.state"
INTENT = "valuelens.audit_refresh_intent"
COMPLETED = "valuelens.audit_refresh_completed_intent"
READY = "valuelens.audit_data_version"
ACK = "valuelens.audit_refreshed.model"
JULY, OCTOBER = "2026-07", "2026-10"
LOCATION = "abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Tables/output"


def processor_namespace():
    code = _processor_code()
    ns = dict(json=json, re=re, datetime=datetime, uuid=uuid, DataFrame=object)
    names = {
        "PROCESSOR_STATE_PROPERTY", "PROCESSOR_STATE_VERSION", "NULL_MONTH",
        "DEFAULT_INCREMENTAL_LOOKBACK_DAYS", "AUDIT_REFRESH_INTENT_PROPERTY",
        "AUDIT_REFRESH_COMPLETED_PROPERTY", "AUDIT_DATA_VERSION_PROPERTY",
        "month_key", "month_start", "month_predicate_sql", "build_processor_state",
        "parse_processor_state", "plan_incremental_months", "pending_audit_refresh_intent",
        "resume_audit_refresh_plan", "set_processor_properties", "prepare_audit_refresh_intent",
        "save_processor_state", "write_curated_output", "publish_curated_output",
    }
    for index in (2, 15):
        nodes = [n for n in ast.parse(code[index]).body
                 if (isinstance(n, ast.FunctionDef) and n.name in names)
                 or (isinstance(n, ast.Assign) and any(
                     isinstance(t, ast.Name) and t.id in names for t in n.targets))]
        exec(compile(ast.Module(body=nodes, type_ignores=[]), f"processor:cell{index}", "exec"), ns)
    # Execute the production planning statements, including intent recovery before source filtering.
    lines = code[3].splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("_target_ready, _state"))
    end = next(i for i, line in enumerate(lines) if line.startswith("PROCESS_PLAN = resume_"))
    ns["_planning"] = compile("\n".join(lines[start:end + 1]), "processor:planning", "exec")
    return ns


class Frame:
    columns = ["MonthStart", "value", "license"]

    def __init__(self, store, rows):
        self.store, self.rows = store, {k: dict(v) for k, v in rows.items()}

    def select(self, *columns):
        assert sorted(c.strip("`") for c in columns) == sorted(self.columns)
        return self

    @property
    def write(self):
        return Writer(self)


class Writer:
    def __init__(self, frame):
        self.frame, self.options = frame, {}

    def mode(self, mode):
        assert mode == "overwrite"
        return self

    def option(self, name, value):
        self.options[name] = value
        return self

    def partitionBy(self, column):
        assert column == "MonthStart"
        return self

    def format(self, format):
        assert format == "delta"
        return self

    def saveAsTable(self, table):
        store = self.frame.store
        store.transition("data-before")
        if "replaceWhere" in self.options:
            months = {m[:7] for m in re.findall(r"DATE'([^']+)'", self.options["replaceWhere"])}
            store.rows = {k: v for k, v in store.rows.items() if k not in months}
            store.write_months.append(sorted(months))
        else:
            store.rows = {}
            store.write_months.append("full")
        store.rows.update(self.frame.rows)
        store.exists = True
        store.transition("data-after")


class Store:
    """Each SQL property update and data write commits atomically, with before/after failures."""

    def __init__(self, *, exists=True, historical_change=True):
        self.ns = processor_namespace()
        self.exists, self.historical_change = exists, historical_change
        self.rows = {JULY: self.row(JULY, 1, "retained"), OCTOBER: self.row(OCTOBER, 1)} if exists else {}
        self.source = {JULY: self.row(JULY, 2), OCTOBER: self.row(OCTOBER, 2)}
        self.source_months = {JULY: "unchanged", OCTOBER: "new"}
        self.properties = {}
        if exists:
            self.properties.update({
                STATE: self.ns["build_processor_state"]("cfg", {JULY: "unchanged", OCTOBER: "old"}),
                READY: "generation-0", ACK: "generation-0",
            })
        self.events, self.write_months, self.source_reads, self.acknowledgements = [], [], [], []
        self.fail_at, self.hook, self.in_scope = None, None, False
        self.ns.update(
            spark=SimpleNamespace(sql=self.sql, table=lambda _: Frame(self, self.rows),
                                  catalog=SimpleNamespace(tableExists=lambda _: self.exists)),
            F=SimpleNamespace(col=lambda c: c), OUT_TABLE="output", PARTITION_COLUMN="MonthStart",
            PROCESSOR_CONFIG="cfg", SOURCE_MONTHS=self.source_months, SOURCE_MAX_CREATION=None,
            WRITE_MODE="merge", INCREMENTAL_LOOKBACK_DAYS=14, MERGE_KEYS=["Id"],
            src_all=SimpleNamespace(columns=["Id"]), _month_stats=[],
            resolve_write_strategy=lambda *args, **kwargs: None,
            ConversationSnapshots=self.snapshots, conversation_snapshot_root=lambda _: "shared-root",
            update_conversation_history=self.history, historical_audit_changed=self.changed,
        )

    @staticmethod
    def row(month, value, license="current"):
        return {"MonthStart": month, "value": value, "license": license}

    def transition(self, event):
        self.events.append(event)
        if self.hook:
            self.hook(event)
        if self.fail_at == event:
            self.fail_at = None
            raise RuntimeError(f"injected {event}")

    @contextmanager
    def snapshots(self, spark, root):
        self.in_scope = True
        try:
            yield self
        finally:
            self.in_scope = False
            self.events.append("scope-exit")

    def sql(self, query):
        if query.startswith("DESCRIBE DETAIL"):
            detail = {"properties": dict(self.properties), "partitionColumns": ["MonthStart"], "location": LOCATION}
            return SimpleNamespace(first=lambda: detail, collect=lambda: [detail])
        assert query.startswith("ALTER TABLE")
        pairs = re.findall(r"'((?:\\.|[^'\\])*)' = '((?:\\.|[^'\\])*)'", query)
        values = {re.sub(r"\\(.)", r"\1", k): re.sub(r"\\(.)", r"\1", v) for k, v in pairs}
        assert values
        event = "prepare" if INTENT in values else "finalize" if READY in values else "state" if STATE in values else "ack"
        if event != "ack":
            assert self.in_scope, "Publisher ended snapshot scope before durable publication"
        self.transition(event + "-before")
        self.properties.update(values)
        if event == "ack":
            self.acknowledgements.append(query)
        self.transition(event + "-after")

    def history(self, replacement, previous, months, snapshots):
        assert snapshots is self and self.in_scope
        rows = dict(replacement.rows)
        # A changed October group updates July's conversation value, not its licence snapshot.
        if OCTOBER in months and JULY not in months:
            july = previous.rows[JULY]
            if july["value"] != self.source[OCTOBER]["value"]:
                rows[JULY] = {**july, "value": self.source[OCTOBER]["value"]}
        return Frame(self, rows), sorted(set(months) | set(rows))

    def changed(self, frame, plan):
        assert self.in_scope
        self.events.append("compare")
        return plan["full"] or (self.historical_change and any(
            self.rows.get(k) != value for k, value in frame.rows.items()))

    def plan(self):
        exec(self.ns["_planning"], self.ns)
        return self.ns["PROCESS_PLAN"]

    def publish(self):
        plan = self.plan()
        months = sorted(self.source) if plan["full"] else plan["months"]
        self.source_reads.append(months)
        frame = Frame(self, {k: v for k, v in self.source.items() if k in months})
        return self.ns["publish_curated_output"](frame, plan)

    def pending(self):
        return self.ns["pending_audit_refresh_intent"](self.properties)

    def refresh(self, api=None):
        api = api or FakeApi([])
        run_notebook(api, self)
        return api


@pytest.mark.parametrize("failure", [
    "prepare-before", "prepare-after", "data-before", "data-after", "finalize-before", "finalize-after",
])
def test_failure_retry_runs_actual_planner_writer_and_atomic_finalization(failure):
    store = Store()
    store.fail_at = failure
    with pytest.raises(RuntimeError, match=failure):
        store.publish()
    assert not store.in_scope
    if failure not in ("prepare-before", "finalize-after"):
        assert store.pending() is not None
        assert store.properties[READY] == "generation-0"
        assert store.ns["parse_processor_state"](store.properties[STATE])["months"][OCTOBER] == "old"
    ready = store.properties[READY]
    store.publish()
    assert store.pending() is None
    assert store.ns["parse_processor_state"](store.properties[STATE])["months"] == store.source_months
    assert store.rows[JULY] == store.row(JULY, 2, "retained")
    assert store.source_reads[0] == [OCTOBER]
    assert store.source_reads[1] == ([] if failure == "finalize-after" else [OCTOBER])
    assert (store.properties[READY] == ready) == (failure == "finalize-after")
    api = store.refresh()
    assert len(api.refresh_bodies) == 2
    assert api.refresh_bodies[-1] == {
        "type": "full", "commitMode": "transactional", "applyRefreshPolicy": False,
        "retryCount": 1, "objects": [{"table": "Chat + Agent Interactions (Audit Logs)"}],
    }
    assert store.properties[ACK] == store.properties[READY]


def test_committed_dependency_month_can_drop_from_retry_without_losing_refresh():
    store = Store()
    store.fail_at = "finalize-before"
    with pytest.raises(RuntimeError):
        store.publish()
    assert store.write_months == [[JULY, OCTOBER]]
    intent = store.pending()
    assert intent["months"] == [JULY, OCTOBER] and intent["source_months"] == [OCTOBER]
    store.publish()
    assert store.write_months == [[JULY, OCTOBER], [OCTOBER]]
    assert store.rows[JULY]["license"] == "retained"
    assert json.loads(store.properties[INTENT])["months"] == [JULY, OCTOBER]
    assert store.properties[READY] != "generation-0"
    # Successful repeat is genuinely a no-op, with no new generation.
    token = store.properties[READY]
    assert store.publish()[0] == "unchanged"
    assert store.properties[READY] == token


def test_fingerprint_reversion_cannot_hide_unfinished_source_recomputation():
    store = Store()
    store.fail_at = "finalize-before"
    with pytest.raises(RuntimeError):
        store.publish()
    store.source_months[OCTOBER] = "old"
    store.source[OCTOBER] = store.row(OCTOBER, 1)
    original = store.ns["plan_incremental_months"](
        store.source_months, store.ns["parse_processor_state"](store.properties[STATE]), "cfg")
    assert original["months"] == [] and not original["full"]
    plan = store.plan()
    assert not plan["full"] and plan["months"] == [OCTOBER]
    store.publish()
    assert store.rows[JULY] == store.row(JULY, 1, "retained")
    assert store.rows[OCTOBER] == store.source[OCTOBER]
    assert store.properties[READY] != "generation-0"


@pytest.mark.parametrize("failure", ["data-before", "data-after", "finalize-before", "finalize-after"])
def test_first_create_retry_and_existing_model_refresh_before_finalization(failure):
    store = Store(exists=False)
    store.fail_at = failure
    with pytest.raises(RuntimeError, match=failure):
        store.publish()
    if failure in ("data-after", "finalize-before"):
        assert STATE not in store.properties and READY not in store.properties
        assert store.plan()["full"]
        # Existing model may refresh here, but no uncommitted generation is acknowledgeable.
        assert len(store.refresh().refresh_bodies) == 1
        assert store.acknowledgements == []
    store.publish()
    assert store.pending() is None
    assert STATE in store.properties and READY in store.properties
    assert store.rows == store.source
    assert len(store.refresh().refresh_bodies) == 2
    assert store.properties[ACK] == store.properties[READY]


def test_prepared_intent_alone_cannot_request_or_acknowledge_a_generation():
    store = Store()
    store.fail_at = "data-before"
    with pytest.raises(RuntimeError):
        store.publish()
    intent = store.pending()
    assert intent is not None
    assert len(store.refresh().refresh_bodies) == 1
    assert store.acknowledgements == []
    assert store.pending() == intent
    store.publish()
    assert len(store.refresh().refresh_bodies) == 2


@pytest.mark.parametrize("state", [None, "", "broken", '{"version":99}', "[]"])
def test_missing_or_invalid_state_keeps_first_create_full_replay_sentinel(state):
    store = Store()
    if state is None:
        del store.properties[STATE]
    else:
        store.properties[STATE] = state
    assert store.plan()["full"]
    store.fail_at = "finalize-before"
    with pytest.raises(RuntimeError):
        store.publish()
    assert store.plan()["full"]
    store.publish()
    assert store.properties[READY] != "generation-0"


@pytest.mark.parametrize("event", ["prepare-after", "data-before", "data-after", "finalize-before", "finalize-after"])
def test_concurrent_refresh_cannot_acknowledge_preparation_or_later_commit(event):
    store = Store()
    store.properties[READY] = "previous-unacknowledged"
    captured = []

    def hook(actual):
        if actual != event:
            return
        store.hook = None
        store.refresh()
        captured.append(store.properties[ACK])

    store.hook = hook
    store.publish()
    assert captured == [store.properties[READY] if event == "finalize-after" else "previous-unacknowledged"]
    if event != "finalize-after":
        assert store.properties[ACK] != store.properties[READY]
        assert len(store.refresh().refresh_bodies) == 2
    assert store.properties[ACK] == store.properties[READY]


def test_delayed_ack_and_second_model_do_not_resolve_new_generation():
    store = Store()
    store.properties[READY] = "previous-unacknowledged"
    api = FakeApi([])
    original_post = api.post

    def post(*args, **kwargs):
        response = original_post(*args, **kwargs)
        if len(api.refresh_bodies) == 1:
            store.publish()
        return response

    api.post = post
    store.refresh(api)
    assert store.properties[ACK] == "previous-unacknowledged"
    assert store.properties[READY] != store.properties[ACK]
    assert "valuelens.audit_refreshed.second-model" not in store.properties
    assert len(store.refresh().refresh_bodies) == 2
    second = FakeApi([])
    run_notebook(second, store, model="second-model")
    assert len(second.refresh_bodies) == 2
    assert store.properties["valuelens.audit_refreshed.second-model"] == store.properties[READY]


@pytest.mark.parametrize("newer_completed", [False, True])
def test_delayed_producer_finalization_cannot_erase_newer_prepared_intent(newer_completed):
    store = Store()
    prepare = store.ns["prepare_audit_refresh_intent"]
    plan = {"full": False, "months": [JULY, OCTOBER]}
    with store.snapshots(None, None):
        older = prepare(plan, [OCTOBER])
        newer = prepare(plan, [OCTOBER])
        if newer_completed:
            store.ns["save_processor_state"](store.properties[STATE], newer)
        store.ns["save_processor_state"](store.properties[STATE], older)
    assert store.pending() == newer
    assert store.properties[COMPLETED] == older["id"]
    store.publish()
    assert store.pending() is None


@pytest.mark.parametrize("event", ["data-after", "finalize-before", "finalize-after"])
def test_driver_termination_leaves_only_durable_state_for_restart(event):
    store = Store()

    def terminate(actual):
        if actual == event:
            raise SystemExit("driver terminated")

    store.hook = terminate
    with pytest.raises(SystemExit, match="driver terminated"):
        store.publish()
    restarted = Store()
    restarted.properties, restarted.rows = dict(store.properties), dict(store.rows)
    restarted.publish()
    assert restarted.pending() is None
    assert restarted.rows[JULY] == store.row(JULY, 2, "retained")
    assert restarted.properties[READY] != "generation-0"
    assert len(restarted.refresh().refresh_bodies) == 2


def test_failed_explicit_rebuild_stays_full_when_retry_returns_to_merge():
    store = Store()
    store.ns["WRITE_MODE"] = "overwrite"
    store.fail_at = "finalize-before"
    with pytest.raises(RuntimeError):
        store.publish()
    store.ns["WRITE_MODE"] = "merge"
    assert store.plan()["full"]
    store.publish()
    assert store.write_months == ["full", "full"]
    assert store.rows == store.source


def test_schema_guard_invalidates_state_without_completing_pending_intent():
    store = Store()
    store.fail_at = "finalize-before"
    with pytest.raises(RuntimeError):
        store.publish()
    frame = Frame(store, {})
    frame.columns = ["MonthStart", "value"]
    plan = store.plan()
    with store.snapshots(None, None), pytest.raises(RuntimeError, match="columns differ"):
        store.ns["write_curated_output"](frame, plan)
    assert store.properties[STATE] == ""
    assert store.pending() is not None
    assert store.properties[READY] == "generation-0"
    assert store.plan()["full"]


@pytest.mark.parametrize("months", [[], [OCTOBER]])
def test_noop_or_nonempty_current_window_rewrite_does_not_rotate_token(months):
    store = Store(historical_change=False)
    if not months:
        store.properties[STATE] = store.ns["build_processor_state"]("cfg", store.source_months)
    store.publish()
    assert INTENT not in store.properties
    assert store.properties[READY] == "generation-0"
    assert len(store.refresh().refresh_bodies) == 1


def test_processor_property_escaping_round_trips_without_separate_publication():
    store = Store()
    state = store.ns["build_processor_state"]("a\\path's-config", store.source_months)
    with store.snapshots(None, None):
        store.ns["save_processor_state"](state)
    assert store.properties[STATE] == state
    assert store.events == ["state-before", "state-after", "scope-exit"]


@pytest.mark.parametrize("prefix", ["'", "'key' = '"])
def test_property_parser_rejects_long_unclosed_escape_sequences_in_bounded_time(prefix):
    import inspect
    import textwrap

    method = ast.parse(textwrap.dedent(inspect.getsource(Store.sql)))
    pattern = next(node.args[0].value for node in ast.walk(method)
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr == "findall")
    query = prefix + "\\&" * 100_000
    subprocess.run(
        [sys.executable, "-c", "import json,re,sys; p,q=json.load(sys.stdin); assert not re.findall(p,q)"],
        input=json.dumps([pattern, query]), text=True, check=True, timeout=5,
    )


@pytest.mark.parametrize("bad", ["not-json", "[]", '{"version":2}', '{"version":1,"id":"bad"}'])
def test_corrupt_intent_fails_closed_instead_of_advancing_state(bad):
    store = Store()
    store.properties[INTENT] = bad
    with pytest.raises(ValueError):
        store.publish()
    assert store.events == []


@pytest.mark.parametrize("failure", ["ack-before", "ack-after"])
def test_ack_failure_keeps_ready_generation_and_safe_retry(failure):
    store = Store()
    store.publish()
    token = store.properties[READY]
    store.fail_at = failure
    with pytest.raises(RuntimeError, match=failure):
        store.refresh()
    api = store.refresh()
    assert len(api.refresh_bodies) == (2 if failure == "ack-before" else 1)
    assert store.properties[ACK] == token == store.properties[READY]
