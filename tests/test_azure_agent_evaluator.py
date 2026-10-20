"""Offline tests for the Azure jobs' Agent Evaluator (module `agentEvaluator`): the transcript parser port against
the Fabric notebook, the Dataverse reader (paging, throttling, fallbacks), incremental month files, UPN lookup,
the parse workers, settings, wiring, publish targets and the V008 migration. Dataverse and Graph are faked under
the real `Api`; Azure SQL is sqlite3."""
from __future__ import annotations

import gzip
import json
import re
import sqlite3
import threading
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote

import duckdb
import pandas as pd
import pytest

from test_agent_evaluator import (USER_A, USER_B, USER_C, canonical, chunked_outputs, dataverse_transcript,
                                  transcript_parse_namespace)
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import publish as pub
from valuelens_jobs import sql as sql_mod
from valuelens_jobs import transcripts as tx
from valuelens_jobs.api import Api, HttpError
from valuelens_jobs.collect import agent_evaluator as ae
from valuelens_jobs.config import Settings, _environments
from valuelens_jobs.storage import LocalStore

ROOT = Path(__file__).resolve().parents[1]
V008 = ROOT / "azure" / "sql" / "migrations" / "V008__agent_evaluator.sql"
ENV_A, ENV_B, ENV_C = "https://a.crm.dynamics.com", "https://b.crm4.dynamics.com", "https://c.crm.dynamics.com"
NOW = datetime(2025, 3, 10, 12, 0, tzinfo=timezone.utc)
USER_D = "44444444-4444-4444-4444-444444444444"
UPNS = {USER_A: "Alex@Example.com", USER_B: "blake@example.com"}
DATE_FILTER = re.compile(r"conversationstarttime (ge|lt) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)")


@pytest.fixture(scope="module")
def ns():
    return transcript_parse_namespace()


# ------------------------------------------------------------------------------------------------------ fakes
class Resp:
    def __init__(self, status, body=None, headers=None):
        self.status_code, self.headers = status, headers or {}
        self._body = {} if body is None else body
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class Http:
    """The Dataverse Web API and Graph $batch, as the real `Api`'s session. `data` is {environment: records}."""

    def __init__(self, data, *, page=2, throttle=(), no_expand=(), deny=False, fail=None, upns=None,
                 graph_status=200, graph_item_429=False):
        self.data, self.page = data, page
        self.throttle, self.no_expand = set(throttle), set(no_expand)
        self.deny, self.fail = deny, fail
        self.upns = UPNS if upns is None else upns
        self.graph_status, self.graph_item_429 = graph_status, graph_item_429
        self.calls, self.posts = [], []
        self.lock = threading.Lock()

    def request(self, method, url, headers=None, timeout=None, json=None, **kw):
        with self.lock:
            self.calls.append((method, url, dict(headers or {})))
        if url.startswith("https://graph.microsoft.com/"):
            return self._graph(json)
        base = url.split("/api/data/")[0]
        if self.deny:
            return Resp(403, {"error": {"code": "0x80040220", "message": "Principal user is missing prvReadbot"}})
        with self.lock:
            if base in self.throttle:
                self.throttle.discard(base)
                return Resp(429, {"error": {"message": "Rate limit exceeded"}}, {"Retry-After": "3"})
        if self.fail and self.fail(url):
            return Resp(500, {"error": {"message": "Generic SQL error"}})
        if base in self.no_expand and "$expand=" in url:
            return Resp(400, {"error": {"message": "Could not find a property named 'bot_conversationtranscriptid'"}})
        bounds = dict(DATE_FILTER.findall(unquote(url)))
        skip = int((re.search(r"\$skiptoken=(\d+)", url) or [0, 0])[1])
        found = []
        for r in self.data.get(base, []):
            t = r["conversationstarttime"]
            if ("ge" in bounds and t < bounds["ge"]) or ("lt" in bounds and t >= bounds["lt"]):
                continue
            r = dict(r)
            if "$expand=" not in url:
                r.pop("bot_conversationtranscriptid", None)
            found.append(r)
        found.sort(key=lambda r: r["conversationtranscriptid"])
        body = {"value": found[skip:skip + self.page]}
        if skip + self.page < len(found):
            body["@odata.nextLink"] = re.sub(r"&\$skiptoken=\d+", "", url) + f"&$skiptoken={skip + self.page}"
        return Resp(200, body)

    def _graph(self, body):
        with self.lock:
            self.posts.append(body)
        if self.graph_status != 200:
            return Resp(self.graph_status, {"error": {"code": "Authorization_RequestDenied"}})
        out = []
        for req in body["requests"]:
            if self.graph_item_429:
                self.graph_item_429 = False
                out.append({"id": req["id"], "status": 429, "headers": {"Retry-After": "7"}, "body": {}})
                continue
            ids = re.findall(r"'([0-9a-f-]{36})'", unquote(req["url"]))
            out.append({"id": req["id"], "status": 200, "body": {"value": [
                {"id": i, "userPrincipalName": self.upns[i]} for i in ids if i in self.upns]}})
        return Resp(200, {"responses": out})


class Tokens:
    def __init__(self, bad=()):
        self.bad, self.scopes = set(bad), []

    def get(self, scope, force=False):
        self.scopes.append(scope)
        if any(scope.startswith(b) for b in self.bad):
            raise RuntimeError(f"AADSTS500011: The resource principal named {scope} was not found in the tenant")
        return "token"


# ---------------------------------------------------------------------------------------------------- helpers
def rec(n, user, days_ago, *, at=NOW, **kw):
    r = dataverse_transcript(n, user, **kw)
    r["conversationstarttime"] = (at - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return r


def settings(*envs, **kw):
    kw.setdefault("transcript_parse_workers", 0)
    return Settings(modules=frozenset({"agentEvaluator"}),
                    dataverse_environments=tuple((e, "") if isinstance(e, str) else e for e in envs), **kw)


def make_api(http, sleeps=None, bad=()):
    return Api(Tokens(bad), session=http, sleep=sleeps.append if sleeps is not None else (lambda s: None))


def rows(store, table):
    """Every row of raw/<table>/*.parquet as dicts (dates and timestamps as ISO strings)."""
    folder = Path(store.path(f"raw/{table}"))
    if not list(folder.glob("*.parquet")):
        return []
    con = duckdb.connect()
    try:
        cur = con.execute(f"SELECT * FROM read_parquet('{folder.as_posix()}/*.parquet', union_by_name=true)")
        names = [d[0] for d in cur.description]
        return [{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in zip(names, row)}
                for row in cur.fetchall()]
    finally:
        con.close()


def by_id(table_rows, key="conversation_id"):
    return {(r[key], r["source_environment"]): r for r in table_rows}


def rich_transcript(n, user, *, schema="copilots_header_x", verdict="like", score=None, reaction=False):
    """One transcript reaching most of the parser: session variables, a long non-ASCII prompt, intent, knowledge,
    a plan step, search grounding, a generative answer, a connected agent, feedback and a user error."""
    start = 1_710_000_000_000 + n * 60_000
    prompt = ("Grüße — wie viele Urlaubstage habe ich noch? 休暇の残り日数は?\n" * 12)[:620]
    intent = {"score": score} if score is not None else {"intentScore": {"score": 0.92}}
    acts = [
        {"type": "event", "name": "SetVariables", "timestampMs": start - 10,
         "value": {"variables": {"ESS_UserContext_UPN": "alex@example.com", "ESS_Message_Disclaimer": "shown"}}},
        {"type": "message", "id": f"u{n}", "channelId": "msteams", "timestampMs": start, "text": prompt,
         "from": {"role": 0, "aadObjectId": user, "userPrincipalName": "alex@example.com"},
         "recipient": {"name": "HR Helper", "id": "bot-hr"}},
        {"type": "trace", "valueType": "IntentRecognition", "replyToId": f"u{n}", "timestampMs": start + 100,
         "value": {"intentTitle": "Leave balance", "intentId": "topic.leave", **intent}},
        {"type": "trace", "valueType": "KnowledgeTraceData", "timestampMs": start + 200,
         "value": {"isKnowledgeSearched": True, "completionState": "Answered",
                   "citedKnowledgeSources": ["https://example.sharepoint.com/sites/hr/leave.docx",
                                             "https://www.example.com/policy"]}},
        {"type": "event", "name": "DynamicPlanStepFinished", "timestampMs": start + 300,
         "value": {"displayedCost": 3, "executionTime": "00:00:01.5000000", "planStepId": "step-1"}},
        {"type": "event", "name": "UniversalSearchToolTraceData", "valueType": "UniversalSearchToolTraceData",
         "timestampMs": start + 400,
         "value": {"knowledgeSources": ["hr-site"], "searchContextTraceInfo": {
             "endpoints": ["https://example.sharepoint.com/sites/hr", "https://www.bing.com/search"]}}},
        {"type": "trace", "valueType": "GenerativeAIResponseTraceData", "timestampMs": start + 500,
         "value": {"completionTokens": 40, "promptTokens": 300}},
        {"type": "trace", "valueType": "ConnectedAgentInitializeTraceData", "timestampMs": start + 600,
         "value": {"connectedAgentBotSchemaName": "msdyn_copilotforemployeeselfserviceit",
                   "parentBotSchemaName": schema or "crb_payroll", "dialogSchemaName": "it.topic",
                   "userId": user, "planStepId": "step-1"}},
        {"type": "trace", "valueType": "ConnectedAgentCompletedTraceData", "timestampMs": start + 900,
         "value": {"connectedAgentBotSchemaName": "msdyn_copilotforemployeeselfserviceit",
                   "parentBotSchemaName": schema or "crb_payroll", "dialogSchemaName": "it.topic",
                   "userId": user, "planStepId": "step-1"}},
        {"type": "message", "id": f"b{n}", "channelId": "msteams", "timestampMs": start + 1500,
         "text": "You have 12 days left.", "from": {"role": 1, "name": "HR Helper", "id": "bot-hr"},
         "channelData": {"feedbackLoop": {"type": "default"}}},
        {"type": "invoke", "name": "message/submitAction", "timestampMs": start + 5000,
         "value": {"actionName": "feedback", "feedback": {"reaction": verdict, "feedbackText": "Thanks — très bien"}}},
        {"type": "trace", "valueType": "ErrorTraceData", "timestampMs": start + 6000,
         "value": {"errorCode": "InvalidInput", "errorSubCode": "Upn", "isUserError": True,
                   "errorMessage": "x" * 700}},
    ]
    if reaction:
        acts.append({"type": "messageReaction", "timestampMs": start + 7000, "reactionsAdded": [{"type": "like"}]})
    out = dataverse_transcript(n, user)
    out.update({
        "conversationtranscriptid": f"00000000-0000-0000-0000-{n:012d}",
        "content": json.dumps({"activities": acts}, ensure_ascii=False),
        "conversationstarttime": datetime.fromtimestamp(start / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bot_conversationtranscriptid": ({"schemaname": schema, "name": "HR Helper", "botid": "bot-hr"}
                                         if schema else None),
    })
    return out


def raw_records():
    """(Dataverse record, environment) pairs: two environments, a returning user, an error, sub-agent calls, two
    rich transcripts (one without a bot lookup) and a structurally corrupt row (its id isn't a GUID)."""
    corrupt = dataverse_transcript(6, USER_B)
    corrupt["conversationtranscriptid"] = 'role":0}'
    return [
        (dataverse_transcript(1, USER_A, error=True), ENV_A),
        (dataverse_transcript(2, USER_B, connected="crb_hr"), ENV_A),
        (dataverse_transcript(3, USER_A, text="again"), ENV_A),
        (rich_transcript(7, USER_A), ENV_A),
        (rich_transcript(8, USER_B, schema=None, verdict="dislike", score=0.5, reaction=True), ENV_A),
        (dataverse_transcript(4, USER_C, env_bot="crb_finance"), ENV_B),
        (dataverse_transcript(5, USER_A, env_bot="crb_finance"), ENV_B),
        (corrupt, ENV_B),
    ]


def notebook_catalogue(ns, sessions, subagents):
    """Cell 8d's agent_catalogue, rebuilt in pandas from the notebook's own build_agent_dim."""
    s = pd.DataFrame(sessions, columns=tx.columns("agent_sessions")[:-1])
    sub = pd.DataFrame(subagents, columns=["connected_agent_schema", "parent_agent_schema"])
    ok = s[s["primary_agent_schema"].notna() & s["agent_name"].notna() & (s["agent_name"].fillna("").str.strip() != "")]
    named = (ok.sort_values(["session_start_utc", "agent_name"], ascending=[False, True], na_position="last")
             .drop_duplicates("primary_agent_schema")[["primary_agent_schema", "agent_name"]])
    every = s.loc[s["primary_agent_schema"].notna(), ["primary_agent_schema"]].drop_duplicates()
    dim = ns["build_agent_dim"](pd.concat([named, every.assign(agent_name=None)], ignore_index=True),
                                sub.drop_duplicates())
    envs = {}
    for r in sessions:
        if r["primary_agent_schema"] is not None and r.get("source_environment"):
            envs.setdefault(r["primary_agent_schema"], set()).add(r["source_environment"])
    dim["source_environments"] = dim["agent_schema"].map({k: "|".join(sorted(v)) for k, v in envs.items()}).fillna("")
    return [dict(zip(dim.columns, (ns["_out_str"](v) for v in row))) for row in dim.itertuples(index=False, name=None)]


def returning(sessions):
    counts = {}
    for r in sessions:
        counts[r["user_id_hash"]] = counts.get(r["user_id_hash"], 0) + 1
    for r in sessions:
        r["is_returning_user"] = "True" if r["user_id_hash"] and counts[r["user_id_hash"]] > 1 else "False"
    return sessions


def without_date(table_rows):
    return [{k: v for k, v in r.items() if k != "transcript_date"} for r in table_rows]


def fabric_pandas(fn, *args):
    """Run the notebook reference with pandas 2.x's object inference, as on Fabric. pandas 3's str dtype turns
    the notebook's None schema hints into truthy NaN in mixed chunks, which blocks its trace-schema fallback."""
    with pd.option_context("future.infer_string", False):
        return fn(*args)


# ------------------------------------------------------------------------------------- parity with Fabric
def test_fact_and_catalogue_columns_match_the_notebook(ns):
    staged = [ns["staged_transcript_record"](r, env) for r, env in raw_records()]
    parsed, _ = ns["parsed_transcript_frame"](staged, "content", "conversationtranscriptid", True)
    assert set(ns["_OUTPUT_BUILDERS"]) == set(tx.FACT_TABLES)
    built = {}
    for table, build in ns["_OUTPUT_BUILDERS"].items():
        built[table] = build(parsed)
        assert list(built[table].columns) == tx.FACT_TABLES[table][1], table
        assert tx.columns(table) == tx.FACT_TABLES[table][1] + ["source_environment", "transcript_date"]
    dim = ns["build_agent_dim"](built["agent_sessions"], built["agent_subagents"])
    assert list(dim.columns) + ["source_environments"] == tx.CATALOGUE_COLUMNS


def test_parse_records_matches_the_notebook(ns):
    raw = raw_records()
    staged = [tx.staged_record(r, env) for r, env in raw]
    assert staged == [ns["staged_transcript_record"](r, env) for r, env in raw]
    records = [tx.normalise(s) for s in staged]
    out, stats = tx.parse_records(records)
    assert stats == {"rows": 8, "valid": 8, "corrupt": 1, "hint": stats["hint"], "failed": 0, "failures": []}
    assert {r["transcript_date"] for r in out["agent_sessions"]} == {"2024-01-01", "2024-03-09"}
    for chunk in (1, 200):
        want, want_stats = fabric_pandas(chunked_outputs, ns, records, chunk)
        for key in ("rows", "valid", "corrupt", "hint"):
            assert stats[key] == want_stats[key], (chunk, key)
        got = {t: without_date(rs) for t, rs in out.items()}
        returning(got["agent_sessions"])
        for table in tx.FACT_TABLES:
            assert canonical(got[table]) == canonical(want.get(table, [])), (chunk, table)
    rich = [r for r in out["agent_sessions"] if r["conversation_id"].endswith("07")]
    assert rich and rich[0]["grounding_source"] == "Mixed (Internal+Web)" and rich[0]["feedback_verdict"]
    assert any(len(r["text_preview_500"] or "") == 500 for r in out["agent_turns"])
    assert all(len(r["error_message"] or "") <= 500 for r in out["agent_errors"])


def test_collect_matches_the_notebook_end_to_end(ns, tmp_path):
    raw = raw_records()
    data = {}
    for r, env in raw:
        data.setdefault(env, []).append(r)
    store = LocalStore(tmp_path)
    s = settings(ENV_A, ENV_B, transcript_lookback_days=0, transcript_resolve_upns=False)
    summary = ae.collect_agent_evaluator(make_api(Http(data, page=3)), store, s, now=NOW)
    assert summary["windows"] == 2 and summary["windows_failed"] == 0 and summary["sessions_total"] == 7
    want, _ = fabric_pandas(chunked_outputs, ns,
                            [tx.normalise(ns["staged_transcript_record"](r, env)) for r, env in raw], 200)
    for table in tx.FACT_TABLES:
        assert canonical(without_date(rows(store, table))) == canonical(want.get(table, [])), table
    assert sorted(p.name for p in Path(store.path("raw/agent_sessions")).glob("*.parquet")) == [
        "month-202401.parquet", "month-202403.parquet"]
    nb = fabric_pandas(notebook_catalogue, ns, want["agent_sessions"], want.get("agent_subagents", []))
    assert canonical(rows(store, "agent_catalogue")) == canonical(nb)
    assert summary["agents"] == len(nb) > 0
    assert not list(tmp_path.rglob("*.jsonl.gz")), "the spool is temporary"


def test_a_transcript_that_breaks_a_builder_is_counted_not_fatal(monkeypatch):
    records = [tx.normalise(tx.staged_record(dataverse_transcript(n, USER_A), ENV_A)) for n in (1, 2, 3)]
    real = tx.transcript_rows

    def flaky(r):
        if r["conversationtranscriptid"].endswith("2"):
            raise KeyError("activities")
        return real(r)

    monkeypatch.setattr(tx, "transcript_rows", flaky)
    out, stats = tx.parse_records(records)
    assert (stats["rows"], stats["valid"], stats["failed"]) == (3, 3, 1)
    assert stats["failures"] == ["00000000-0000-0000-0000-000000000002: KeyError: 'activities'"]
    assert len(out["agent_sessions"]) == 2


def test_malformed_transcripts_read_as_missing_values():
    odd = [
        None, 5, "x",
        {"type": "message", "from": "someone", "text": 12345, "timestampMs": "soon"},
        {"type": "message", "from": {"role": 0, "aadObjectId": USER_B}, "text": {"rich": True}, "timestampMs": 1e300},
        {"type": "trace", "valueType": "ErrorTraceData", "value": "boom"},
        {"type": "trace", "valueType": "IntentRecognition", "replyToId": ["not", "hashable"],
         "value": {"intentScore": "high"}},
        {"type": "event", "value": {"displayedCost": "lots", "executionTime": 99}},
        {"type": "trace", "valueType": "KnowledgeTraceData",
         "value": {"isKnowledgeSearched": True, "citedKnowledgeSources": 3}},
        {"type": "event", "name": "UniversalSearchToolTraceData", "value": {"searchContextTraceInfo": "bing.com"}},
        {"type": "trace", "valueType": "ConnectedAgentInitializeTraceData", "value": None},
    ]
    contents = [
        json.dumps({"activities": odd}),
        json.dumps({"activities": {"type": "message"}}),
        "[]",
        json.dumps({"activities": [{"type": "message", "from": {"role": 0, "aadObjectId": USER_A}, "text": "hi",
                                    "timestampMs": 1_700_000_000_000}]}),
        "just text",
    ]
    records = []
    for n, content in enumerate(contents, 1):
        r = dataverse_transcript(n, USER_A)
        r["content"] = content
        records.append(tx.normalise(tx.staged_record(r, ENV_A)))
    out, stats = tx.parse_records(records)
    assert stats["failed"] == 0, stats["failures"]
    assert (stats["rows"], stats["valid"], stats["corrupt"]) == (5, 4, 0)
    assert len(out["agent_sessions"]) == 4


def test_spooled_chunks_round_trip_through_duckdb(tmp_path):
    texts = ["héllo ✓ 日本", "grüße 日本", "bad \ud800 char"]
    records = [tx.normalise(tx.staged_record(dataverse_transcript(n, USER_A, text=t), ENV_A))
               for n, t in enumerate(texts, 1)]
    b1, c1, _ = tx.encode_chunk(records[:2])
    b2, c2, _ = tx.encode_chunk(records[2:])
    assert gzip.decompress(b1["agent_turns"]).count(b"\n") == c1["agent_turns"] == 4
    path = tmp_path / "agent_turns.jsonl.gz"
    path.write_bytes(b1["agent_turns"] + b2["agent_turns"])
    spec = "{" + ", ".join(f"'{c}': '{ae._type(c)}'" for c in tx.columns("agent_turns")) + "}"
    con = duckdb.connect()
    try:
        got = con.execute(f"SELECT text_preview_500, transcript_date FROM read_json('{path.as_posix()}', "
                          f"format='newline_delimited', compression='gzip', columns={spec})").fetchall()
    finally:
        con.close()
    assert len(got) == c1["agent_turns"] + c2["agent_turns"] == 6
    users = [t for t, _ in got if "line two" in (t or "")]
    assert sum("日本" in t for t in users) == 2 and any("bad ? char" in t for t in users)
    assert {d.isoformat() for _, d in got} == {"2024-01-01"}
    assert tx.encode_chunk([])[0] == {t: b"" for t in tx.FACT_TABLES}


# ------------------------------------------------------------------------------------------------ the reader
def test_fetch_window_pages_throttles_and_filters():
    http, sleeps, pages = Http({ENV_A: [rec(n, USER_A, n) for n in range(1, 6)]}, throttle=[ENV_A]), [], []
    api = make_api(http, sleeps)
    n = ae.fetch_window(api, ENV_A + "/", "2025-03-01T00:00:00Z", "2025-03-10T00:00:00Z", pages.append, page_size=2)
    assert n == 5 and [len(p) for p in pages] == [2, 2, 1] and sleeps == [3.0]
    urls = [u for _, u, _ in http.calls]
    assert len(urls) == 4 and urls[0] == urls[1] == (
        f"{ENV_A}/api/data/v9.2/conversationtranscripts?$select={tx.SELECT}&$expand={tx.EXPAND}"
        "&$filter=conversationstarttime ge 2025-03-01T00:00:00Z and conversationstarttime lt 2025-03-10T00:00:00Z")
    assert {h["Prefer"] for _, _, h in http.calls} == {"odata.maxpagesize=2"}
    assert set(api.tokens.scopes) == {f"{ENV_A}/.default"}


def test_fetch_window_reads_without_the_bot_lookup_when_dataverse_rejects_it():
    http, pages = Http({ENV_B: [rec(n, USER_B, n) for n in (1, 2, 3)]}, page=5, no_expand=[ENV_B]), []
    assert ae.fetch_window(make_api(http), ENV_B, "2025-03-07T00:00:00Z", None, pages.append) == 3
    first, second = [u for _, u, _ in http.calls]
    assert "$expand=" in first and "$expand=" not in second
    assert second.endswith("&$filter=conversationstarttime ge 2025-03-07T00:00:00Z")
    assert all("bot_conversationtranscriptid" not in r for p in pages for r in p)


def test_fetch_window_explains_a_missing_role_and_reads_everything_unbounded():
    with pytest.raises(HttpError) as err:
        ae.fetch_window(make_api(Http({}, deny=True)), ENV_A, None, None, lambda page: None)
    assert err.value.status_code == 403 and "Bot Transcript Viewer" in str(err.value)
    http = Http({ENV_A: [rec(1, USER_A, 1), rec(2, USER_A, 900)]})
    assert ae.fetch_window(make_api(http), ENV_A, None, None, lambda page: None) == 2
    assert "$filter" not in http.calls[0][1]


# ---------------------------------------------------------------------------------------------- whole runs
def history():
    return {
        ENV_A: [rec(1, USER_A, 1, error=True), rec(2, USER_B, 2, connected="crb_hr"), rec(3, USER_A, 3, text="again"),
                rec(4, USER_C, 40)],
        ENV_B: [rec(5, USER_B, 5), rec(6, USER_D, 6), rec(8, USER_A, 100)],
    }


def test_runs_merge_history_reuse_upns_and_rebuild_the_catalogue(tmp_path):
    data, store, sleeps = history(), LocalStore(tmp_path), []
    s = settings(ENV_A, (ENV_B, "Sales EU"), ENV_C)
    http = Http(data, throttle=[ENV_A], no_expand=[ENV_B])
    out = ae.collect_agent_evaluator(make_api(http, sleeps, bad=[ENV_C]), store, s, now=NOW)
    assert sleeps == [3.0]
    assert out["environments"] == {ENV_A: {"days": 180, "transcripts": 4, "status": "ok"},
                                   ENV_B: {"days": 180, "transcripts": 3, "status": "ok"},
                                   ENV_C: {"days": 180, "transcripts": 0, "status": "forbidden"}}
    assert (out["windows"], out["windows_failed"], out["sessions_total"]) == (8, 0, 7)
    assert (out["upns_resolved"], out["upns_reused"]) == (2, 0) and "upn_lookup_error" not in out
    assert len(out["warnings"]) == 1 and out["warnings"][0].startswith(
        "c.crm.dynamics.com: Couldn't sign in to the environment: AADSTS500011")
    status = {r["EnvironmentUrl"]: r for r in rows(store, "evaluator_status")}
    assert [(status[u]["Environment"], status[u]["Status"]) for u in (ENV_A, ENV_B, ENV_C)] == [
        ("a.crm.dynamics.com", "ok"), ("Sales EU", "ok"), ("c.crm.dynamics.com", "forbidden")]
    assert status[ENV_A]["Reason"] == "4 transcripts in the last 180 days" and status[ENV_A]["LookbackDays"] == 180
    sessions = by_id(rows(store, "agent_sessions"))
    assert len(sessions) == 7
    assert {r["user_id_hash"]: (r["is_returning_user"], r["user_upn"]) for r in sessions.values()} == {
        USER_A: ("True", "alex@example.com"), USER_B: ("True", "blake@example.com"),
        USER_C: ("False", None), USER_D: ("False", None)}
    assert sorted(p.name for p in Path(store.path("raw/agent_sessions")).glob("*")) == [
        "month-202411.parquet", "month-202501.parquet", "month-202503.parquet"]
    assert store.read_json(ae.STATE) == {"last_success": {ENV_A: NOW.isoformat(), ENV_B: NOW.isoformat()}}
    catalogue = {r["agent_schema"]: (r["agent_display_name"], r["agent_class"], r["source_environments"])
                 for r in rows(store, "agent_catalogue")}
    assert catalogue == {"crb_helpdesk": ("Helpdesk", "Custom Declarative", ENV_A),
                         "crb_hr": ("HR", "Custom Declarative", ""), "Helpdesk": ("Helpdesk", "Other", ENV_B)}

    # A day later: transcript 2 is read again without its connected agent, and transcript 7 is new.
    at = NOW + timedelta(days=1)
    data[ENV_A][1] = rec(2, USER_B, 2)
    data[ENV_A].append(rec(7, USER_A, 0, at=at))
    http = Http(data, no_expand=[ENV_B])
    out = ae.collect_agent_evaluator(make_api(http), store, s, now=at)
    assert {u: (e["days"], e["transcripts"], e["status"]) for u, e in out["environments"].items()} == {
        ENV_A: (14, 4, "ok"), ENV_B: (14, 2, "ok"), ENV_C: (180, 0, "empty")}
    assert {r["EnvironmentUrl"]: r["Reason"] for r in rows(store, "evaluator_status")}[ENV_C] == (
        "0 transcripts found in the last 180 days")
    assert (out["sessions_total"], out["upns_reused"], out["upns_resolved"]) == (8, 2, 0)
    assert (out["months_written"], out["months_removed"]) == (3, 1) and "warnings" not in out
    assert [re.findall(r"'([0-9a-f-]{36})'", unquote(r["url"])) for p in http.posts for r in p["requests"]] == [
        [USER_D]]
    sessions = by_id(rows(store, "agent_sessions"))
    assert len(sessions) == 8 and sessions[("00000000-0000-0000-0000-000000000007", ENV_A)]["user_upn"] == (
        "alex@example.com")
    assert sessions[("00000000-0000-0000-0000-000000000004", ENV_A)]["is_returning_user"] == "False"
    assert rows(store, "agent_subagents") == []
    assert {r["agent_schema"] for r in rows(store, "agent_catalogue")} == {"crb_helpdesk", "Helpdesk"}
    assert store.read_json(ae.STATE) == {"last_success": {u: at.isoformat() for u in (ENV_A, ENV_B, ENV_C)}}

    # An hour later nothing has changed, so no month file is written.
    out = ae.collect_agent_evaluator(make_api(Http(data, no_expand=[ENV_B])), store, s, now=at + timedelta(hours=1))
    assert (out["months_written"], out["months_removed"], out["sessions_total"]) == (0, 0, 8)


def test_a_run_that_reads_nothing_says_why_and_keeps_history(tmp_path):
    store, s = LocalStore(tmp_path), settings(ENV_A, ENV_B)
    data = {ENV_A: [rec(1, USER_A, 1)], ENV_B: [rec(2, USER_B, 1)]}
    ae.collect_agent_evaluator(make_api(Http(data)), store, s, now=NOW)
    before, state = rows(store, "agent_sessions"), store.read_json(ae.STATE)
    with pytest.raises(RuntimeError, match="Agent Evaluator read no environment"):
        ae.collect_agent_evaluator(make_api(Http(data, deny=True)), store, s, now=NOW + timedelta(days=1))
    status = rows(store, "evaluator_status")
    assert [r["Status"] for r in status] == ["forbidden", "forbidden"]
    assert all(r["Reason"].startswith("Couldn't read transcripts: ") and "Bot Transcript Viewer" in r["Reason"]
               for r in status)
    with pytest.raises(RuntimeError, match="Couldn't sign in to the environment"):
        ae.collect_agent_evaluator(make_api(Http(data), bad=[ENV_A, ENV_B]), store, s, now=NOW + timedelta(days=2))
    assert {r["Status"] for r in rows(store, "evaluator_status")} == {"forbidden"}
    assert rows(store, "agent_sessions") == before and store.read_json(ae.STATE) == state


def test_the_merge_caps_duckdb_memory_unless_the_setting_does(tmp_path, monkeypatch):
    caps = []

    class Con:
        def __init__(self):
            self.con = duckdb.connect()

        def execute(self, sql, *args):
            caps.extend(re.findall(r"SET memory_limit = '([^']*)'", sql))
            return self.con.execute(sql, *args)

        def close(self):
            self.con.close()

    monkeypatch.setattr(ae, "duckdb", type("DuckDB", (), {"connect": Con}))
    monkeypatch.delenv("VALUELENS_DUCKDB_MEMORY_LIMIT", raising=False)
    data = {ENV_A: [rec(1, USER_A, 1)]}
    ae.collect_agent_evaluator(make_api(Http(data)), LocalStore(tmp_path / "a"), settings(ENV_A), now=NOW)
    monkeypatch.setenv("VALUELENS_DUCKDB_MEMORY_LIMIT", "1GB")
    out = ae.collect_agent_evaluator(make_api(Http(data)), LocalStore(tmp_path / "b"), settings(ENV_A), now=NOW)
    assert caps == [ae.MERGE_MEMORY, "1GB"] and out["sessions_total"] == 1


def test_a_failed_window_keeps_the_rest_and_is_read_again(tmp_path):
    store, sleeps = LocalStore(tmp_path), []
    http = Http({ENV_A: [rec(1, USER_A, 2), rec(4, USER_C, 100)]},
                fail=lambda u: u.startswith(ENV_A) and " lt " not in u)
    out = ae.collect_agent_evaluator(make_api(http, sleeps), store, settings(ENV_A), now=NOW)
    assert (out["windows"], out["windows_failed"], out["sessions_total"]) == (4, 1, 1)
    assert sleeps == [2, 4, 8, 16, 32]
    status = rows(store, "evaluator_status")
    assert [(r["Status"], r["Reason"]) for r in status] == [
        ("ok", "1 transcripts in the last 180 days (1 read window(s) failed; the next run reads them again)")]
    assert out["warnings"] == [f"a.crm.dynamics.com: {status[0]['Reason']}"]
    assert store.read_json(ae.STATE) == {"last_success": {}}


def test_no_environments_is_a_clear_error(tmp_path):
    with pytest.raises(ValueError, match="VALUELENS_DATAVERSE_ENVIRONMENTS"):
        ae.collect_agent_evaluator(make_api(Http({})), LocalStore(tmp_path), settings(), now=NOW)


def test_backfill_widens_the_first_read_but_not_a_full_pull(tmp_path):
    data = {ENV_A: [rec(1, USER_A, 300)]}
    for sub, kw, days, windows in (("a", {}, 365, 4), ("b", {"transcript_lookback_days": 0}, 0, 1)):
        (tmp_path / sub).mkdir()
        out = ae.collect_agent_evaluator(make_api(Http(data)), LocalStore(tmp_path / sub),
                                         settings(ENV_A, audit_backfill_days=365, **kw), now=NOW)
        assert (out["environments"][ENV_A], out["windows"]) == (
            {"days": days, "transcripts": 1, "status": "ok"}, windows), sub


def test_read_windows_and_lookback():
    assert tx.windows(8, 4, NOW) == [("2025-03-02T12:00:00Z", "2025-03-04T12:00:00Z"),
                                     ("2025-03-04T12:00:00Z", "2025-03-06T12:00:00Z"),
                                     ("2025-03-06T12:00:00Z", "2025-03-08T12:00:00Z"),
                                     ("2025-03-08T12:00:00Z", None)]
    assert tx.windows(0, 4, NOW) == [(None, None)]
    assert tx.windows(5, 1, NOW) == [("2025-03-05T12:00:00Z", None)]
    ago = lambda **kw: (NOW - timedelta(**kw)).isoformat()  # noqa: E731
    assert tx.env_lookback(None, NOW, 14, 180) == 180
    assert tx.env_lookback("not a time", NOW, 14, 180) == 180
    assert tx.env_lookback(ago(days=30), NOW, 14, 180) == 31
    assert tx.env_lookback(ago(days=400), NOW, 14, 180) == 180
    assert tx.env_lookback(ago(hours=1), NOW, 14, 180) == 14
    assert tx.env_lookback(None, NOW, 0, 180) == 0
    assert tx.env_lookback(None, NOW, 30, 7) == 30


# ----------------------------------------------------------------------------------------------------- UPNs
def test_upn_lookup_batches_ids_and_waits_when_throttled():
    ids = [f"{n:08x}-0000-0000-0000-000000000000" for n in range(16)]
    http = Http({}, upns={ids[0]: "First@Example.com", ids[15]: " LAST@example.com"})
    assert ae.resolve_upns(make_api(http), ids) == {ids[0]: "first@example.com", ids[15]: "last@example.com"}
    assert [[len(re.findall(r"'[0-9a-f-]{36}'", unquote(r["url"]))) for r in p["requests"]]
            for p in http.posts] == [[15, 1]]
    http, sleeps = Http({}, graph_item_429=True), []
    assert ae.resolve_upns(make_api(http, sleeps), [USER_A, USER_B]) == {
        USER_A: "alex@example.com", USER_B: "blake@example.com"}
    assert sleeps == [7.0] and len(http.posts) == 2


def test_upn_lookup_is_best_effort_and_can_be_turned_off(tmp_path):
    data = {ENV_A: [rec(1, USER_A, 1)]}
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    store = LocalStore(tmp_path / "a")
    out = ae.collect_agent_evaluator(make_api(Http(data, graph_status=403)), store, settings(ENV_A), now=NOW)
    assert out["upn_lookup_error"].startswith("PermissionError: Graph returned HTTP 403")
    assert [r["user_upn"] for r in rows(store, "agent_sessions")] == [None]
    http = Http(data)
    out = ae.collect_agent_evaluator(make_api(http), LocalStore(tmp_path / "b"),
                                     settings(ENV_A, transcript_resolve_upns=False), now=NOW)
    assert http.posts == [] and out["sessions_total"] == 1


# ------------------------------------------------------------------------------------------------- settings
def test_dataverse_environments_setting():
    assert _environments("") == _environments(None) == ()
    assert _environments(f" {ENV_A}/ , {ENV_B},{ENV_A.upper()}") == ((ENV_A, ""), (ENV_B, ""))
    assert _environments(json.dumps([{"url": ENV_A + "/", "name": " Sales "}, ENV_B, {"url": ""}])) == (
        (ENV_A, "Sales"), (ENV_B, ""))
    assert _environments(json.dumps({"url": ENV_C, "name": "HR"})) == ((ENV_C, "HR"),)
    for bad, message in (("http://a.crm.dynamics.com", "isn't an https://"), ("[1]", "must list"),
                         ("[{", "not valid JSON")):
        with pytest.raises(ValueError, match=message):
            _environments(bad)


def test_agent_evaluator_settings_from_the_environment():
    fields = ("dataverse_environments", "transcript_lookback_days", "transcript_first_read_days",
              "transcript_windows", "transcript_parallel", "transcript_page_size", "transcript_parse_workers",
              "transcript_resolve_upns")
    s = Settings.from_env({
        "VALUELENS_DATAVERSE_ENVIRONMENTS": json.dumps([{"url": ENV_A, "name": "Sales"}]),
        "VALUELENS_TRANSCRIPT_LOOKBACK_DAYS": "0", "VALUELENS_TRANSCRIPT_FIRST_READ_DAYS": "30",
        "VALUELENS_TRANSCRIPT_WINDOWS": "8", "VALUELENS_TRANSCRIPT_PARALLEL": "2",
        "VALUELENS_TRANSCRIPT_PAGE_SIZE": "500", "VALUELENS_TRANSCRIPT_PARSE_WORKERS": "0",
        "VALUELENS_TRANSCRIPT_RESOLVE_UPNS": "false"})
    assert tuple(getattr(s, f) for f in fields) == (((ENV_A, "Sales"),), 0, 30, 8, 2, 500, 0, False)
    assert tuple(getattr(Settings.from_env({}), f) for f in fields) == ((), 14, 180, 4, 4, 1000, -1, True)


# ---------------------------------------------------------------------------------------- wiring and publish
def test_collect_and_publish_follow_the_agent_evaluator_module(tmp_path, monkeypatch):
    from valuelens_jobs.collect import audit, graph

    called = []
    for mod, name in ((graph, "collect_licensed"), (audit, "collect_audit"), (ae, "collect_agent_evaluator")):
        monkeypatch.setattr(mod, name, lambda *a, _n=name, **k: called.append(_n))
    store = LocalStore(tmp_path)
    jobs_main.collect(store, Settings(modules=frozenset({"core"})), api=object())
    assert "collect_agent_evaluator" not in called
    called.clear()
    jobs_main.collect(store, Settings(modules=frozenset({"agentEvaluator"})), api=object())
    assert called == ["collect_agent_evaluator"]
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core", "agentEvaluator"}))) == [
        "curated", "licensed", *pub.AGENT_EVALUATOR]
    sample = jobs_main.publish_targets(Settings(modules=frozenset({"core", "agentEvaluator"}), sample_data=True))
    assert not set(sample) & set(pub.AGENT_EVALUATOR)
    assert pub.AGENT_EVALUATOR == [*tx.FACT_TABLES, "agent_catalogue", "evaluator_status"]
    for name in pub.AGENT_EVALUATOR:
        t = pub.TARGETS[name]
        assert (t.table, t.prefix, t.incremental) == (name, ae.prefix(name), False)
        assert t.partition == ("transcript_date" if name in tx.FACT_TABLES else None)
    assert ae.CATALOGUE.startswith(ae.prefix("agent_catalogue") + "/")
    assert ae.STATUS.startswith(ae.prefix("evaluator_status") + "/")


def _v008_tables() -> dict:
    sql = V008.read_text(encoding="utf-8")
    out = {}
    for name, body in re.findall(r"CREATE TABLE dbo\.(\w+) \((.*?)\n\);", sql, re.S):
        out[name] = [tuple(m) for m in re.findall(r"\[(\w+)\] ([A-Z0-9]+(?:\(\d+\))?) NULL", body)]
    return out


def test_v008_matches_the_parser_columns():
    sql = V008.read_text(encoding="utf-8")
    assert sql_mod.batches(sql) and all(str(b).strip() for b in sql_mod.batches(sql))
    assert [v for v, _ in sql_mod.migrations(V008.parent)][:8] == list(range(1, 9))
    assert "WHERE version = 8)" in sql and "VALUES (8," in sql
    tables = _v008_tables()
    assert list(tables) == pub.AGENT_EVALUATOR
    for t in tx.FACT_TABLES:
        assert tables[t] == [(c, pub.sql_type(ae._type(c))) for c in tx.columns(t)], t
        assert f"CREATE CLUSTERED INDEX cix_{t} ON dbo.{t} ([transcript_date]);" in sql
    assert tables["agent_catalogue"] == [(c, "NVARCHAR(4000)") for c in tx.CATALOGUE_COLUMNS]
    assert tables["evaluator_status"] == [(c, pub.sql_type(t)) for c, t in zip(tx.STATUS_COLUMNS, tx.STATUS_TYPES)]


def test_publish_onto_v008_tables_in_sqlite(tmp_path):
    data = {}
    for r, env in raw_records():
        data.setdefault(env, []).append(r)
    store = LocalStore(tmp_path)
    ae.collect_agent_evaluator(make_api(Http(data, page=3)), store,
                               settings(ENV_A, ENV_B, transcript_lookback_days=0), now=NOW)
    conn = sqlite3.connect(":memory:")
    for name, cols in _v008_tables().items():
        conn.execute(f"CREATE TABLE [{name}] ({', '.join(f'[{c}] {t} NULL' for c, t in cols)})")
    results = {r["table"]: r for r in pub.publish(conn, store, pub.AGENT_EVALUATOR)}
    assert set(results) == set(pub.AGENT_EVALUATOR)
    for name in pub.AGENT_EVALUATOR:
        assert conn.execute(f"SELECT count(*) FROM [{name}]").fetchone() == (len(rows(store, name)),), name
    assert conn.execute("SELECT count(*) FROM agent_sessions").fetchone() == (7,)
    assert conn.execute("SELECT count(DISTINCT transcript_date) FROM agent_sessions").fetchone() == (2,)
    again = {r["table"]: r for r in pub.publish(conn, store, pub.AGENT_EVALUATOR)}
    assert [again[t]["days_changed"] for t in tx.FACT_TABLES] == [0] * len(tx.FACT_TABLES)


# ------------------------------------------------------------------------------------------- parse workers
class NoProcesses:
    def __init__(self, *args, **kwargs):
        raise OSError("no process support here")


class DiesPool:
    def __init__(self, *args, **kwargs):
        pass

    def submit(self, fn, *args):
        future = Future()
        future.set_exception(BrokenProcessPool("a worker died"))
        return future

    def shutdown(self, **kwargs):
        pass


def _spool(folder):
    return {p.name: sorted(gzip.decompress(p.read_bytes()).decode("utf-8").splitlines())
            for p in sorted(Path(folder).glob("*.jsonl.gz"))}


def _parse_with(folder, workers):
    folder.mkdir()
    records = [tx.normalise(tx.staged_record(r, env)) for r, env in raw_records()]
    parser = ae._Parser(folder, workers)
    for batch in (records[:3], records[3:5], records[5:]):
        parser.put(batch)
    assert parser.close() is None
    return parser


def test_parse_workers_match_parsing_in_the_job_process(tmp_path):
    inline, pool = _parse_with(tmp_path / "inline", 0), _parse_with(tmp_path / "pool", 2)
    assert inline.inline and not pool.inline
    assert (pool.counts, pool.stats) == (inline.counts, inline.stats) and inline.counts["agent_sessions"] == 7
    assert _spool(tmp_path / "pool") == _spool(tmp_path / "inline") != {}


@pytest.mark.parametrize("pool", [NoProcesses, DiesPool])
def test_parsing_falls_back_to_the_job_process_when_workers_fail(tmp_path, monkeypatch, pool):
    inline = _parse_with(tmp_path / "inline", 0)
    monkeypatch.setattr(ae, "ProcessPoolExecutor", pool)
    fallback = _parse_with(tmp_path / "pool", 2)
    assert fallback.inline and (fallback.counts, fallback.stats) == (inline.counts, inline.stats)
    assert _spool(tmp_path / "pool") == _spool(tmp_path / "inline") and fallback.counts["agent_sessions"] == 7
