"""Agent Evaluator transcript parsing for the Azure jobs.

A pure-Python port of the Fabric parser notebook
(fabric/notebooks/agent-evaluator/Copilot_Agent_Transcript_Parser.ipynb), so both install paths turn the same
Dataverse `conversationtranscripts` into the same agent_* rows. No pandas or Spark: a row is a dict of strings
(or None), exactly what the notebook's all-string Delta tables hold. Two values need every transcript
(is_returning_user and the agent catalogue), so the collector works them out after the merge.

Privacy matches Fabric: message text is cut to a 500-character preview, the raw transcript `content` is never
stored, and `user_id_hash` holds the user's Entra object ID (not a hash, despite the name) so sessions join to
org data.

This module is deliberately outside valuelens_core: any change there forces a full rebuild of the curated
Copilot interactions.
"""
from __future__ import annotations

import gzip
import json
import math
import re
from datetime import date, datetime, timedelta, timezone

TEXT_TRUNCATE = 500

# --------------------------------------------------------------------------------------------- Dataverse query
SELECT = ("conversationtranscriptid,content,conversationstarttime,schemaversion,schematype,name,metadata,"
          "statecode,statuscode,createdon")
# The bot lookup carries the real Copilot Studio agent, so single-agent transcripts still resolve one.
EXPAND = "bot_conversationtranscriptid($select=schemaname,name,botid)"
# What the notebook's staging step keeps of each record (Spark reads the staged JSON with this schema).
TX_COLUMNS = [c.strip().lower() for c in SELECT.split(",")] + ["bot_conversationtranscriptid", "SourceEnvironment"]

# ------------------------------------------------------------------------------------------------- the tables
SESSION_COLUMNS = [
    "conversation_id", "session_start_utc", "session_duration_ms", "user_id_hash", "user_upn",
    "primary_agent_schema", "connected_agent_schemas", "connected_agent_count", "agent_name", "agent_id",
    "msg_count", "user_msg_count", "bot_msg_count", "plan_step_count", "total_displayed_cost", "total_latency_ms",
    "knowledge_searched", "knowledge_answered", "knowledge_sources_count", "grounding_source", "error_count",
    "first_error_code", "feedback_offered_count", "feedback_submitted", "feedback_verdict", "feedback_comment",
    "first_user_prompt", "session_outcome_explicit", "session_outcome_reason_explicit", "is_authenticated",
    "is_returning_user", "primary_topic_derived"]
TURN_COLUMNS = [
    "conversation_id", "turn_id", "turn_timestamp_utc", "turn_role", "turn_channel", "from_user_hash",
    "text_preview_500", "text_length", "intent_title", "intent_id", "intent_score", "knowledge_searched",
    "knowledge_answered", "knowledge_sources", "feedback_offered", "feedback_verdict", "feedback_comment"]
ERROR_COLUMNS = ["conversation_id", "error_timestamp_utc", "error_code", "error_sub_code", "error_message",
                 "is_user_error"]
SUBAGENT_COLUMNS = ["conversation_id", "invocation_timestamp_utc", "event_type", "parent_agent_schema",
                    "connected_agent_schema", "dialog_schema", "user_id_hash", "plan_step_id"]
PERFORMANCE_COLUMNS = [
    "ConversationTranscriptId", "ConversationStartTime", "SchemaVersion", "BotName", "BotId", "AADTenantId",
    "BatchId", "SessionStartTimeUtc", "SessionEndTimeUtc", "SessionType", "SessionOutcome", "TurnCount",
    "OutcomeReason", "ImpliedSuccess", "LastUserIntentId", "IsDesignMode", "Locale", "UserMessageCount",
    "BotMessageCount", "TotalMessageCount", "FirstUserMessage", "LastUserMessage", "FirstBotMessage",
    "LastBotMessage", "TopicsTriggered", "TopicCount", "PrimaryTopic", "DurationSeconds", "AverageLatencyMs",
    "Var_ESS_UserContext_UPN", "Var_ESS_Message_Disclaimer", "Var_ESS_UserContext_RefreshInterval_Hours",
    "Var_ESS_UserContext_Conversation_Initialized", "AllVariables", "TotalActivityCount", "TraceActivityCount",
    "EventActivityCount", "StatusCode", "StateCode", "FirstErrorCode", "ErrorCategory", "IsAuthenticated",
    "MultiAgentSession", "SessionOutcomeExplicit", "SessionOutcomeReasonExplicit", "GenerativeResponseCount",
    "LLMCallCount", "PromptTokenCount", "CompletionTokenCount", "TotalTokenCount", "PluginCallCount",
    "PluginSuccessCount", "TopicsStarted", "TopicsCompleted", "TopicCompletionRate", "PrimaryTopicDwellMs",
    "TotalTopicDwellMs"]
# Added to every fact row on Azure: the environment it came from (as Fabric) and the day the conversation
# started (UTC), which the month files and the SQL publish are partitioned on.
EXTRA_COLUMNS = ["source_environment", "transcript_date"]

# Fact table -> (column holding the transcript id, the notebook's columns). Every fact row of a transcript is
# replaced together when that transcript is read again.
FACT_TABLES = {
    "agent_sessions": ("conversation_id", SESSION_COLUMNS),
    "agent_turns": ("conversation_id", TURN_COLUMNS),
    "agent_errors": ("conversation_id", ERROR_COLUMNS),
    "agent_subagents": ("conversation_id", SUBAGENT_COLUMNS),
    "agent_performance": ("ConversationTranscriptId", PERFORMANCE_COLUMNS),
}
CATALOGUE_COLUMNS = ["agent_schema", "agent_display_name", "agent_class", "source_environments"]
STATUS_COLUMNS = ["RunAt", "Environment", "EnvironmentUrl", "LookbackDays", "Transcripts", "Status", "Reason"]
STATUS_TYPES = ["TIMESTAMP", "VARCHAR", "VARCHAR", "BIGINT", "BIGINT", "VARCHAR", "VARCHAR"]


def columns(table: str) -> list[str]:
    """Every column a fact table holds on Azure, in order."""
    return FACT_TABLES[table][1] + EXTRA_COLUMNS


# ----------------------------------------------------------------------------------------------------- staging
def staged_record(rec: dict, env: str | None = None) -> dict:
    """One transcript as a flat record of strings: keys lower-cased, OData annotations and lookup values
    (@..., _...) dropped, None as '', the nested bot lookup kept as JSON text. `env` becomes SourceEnvironment."""
    out = {}
    for k, v in rec.items():
        key = str(k).lower()
        if key.startswith("@") or key.startswith("_"):
            continue
        if v is None:
            out[key] = ""
        elif isinstance(v, (dict, list)):
            out[key] = json.dumps(v, ensure_ascii=False, sort_keys=True)
        else:
            out[key] = str(v)
    if env is not None:
        out["SourceEnvironment"] = env
    return out


def normalise(rec: dict) -> dict:
    """Only the staged columns, missing ones as '' (what the notebook's Spark read with na.fill('') gives)."""
    return {c: rec.get(c) or "" for c in TX_COLUMNS}


# ------------------------------------------------------------------------------------------- notebook helpers
_TRANSCRIPT_ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_UPN_OK = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
# Teams thread/channel identities also contain "@" but are not people.
_UPN_NO = re.compile(r"@thread\.|@unq\.gbl|^(?:8|19|28|29|48):|^a:1", re.I)
# A raw Teams/thread identity or a GUID must never become an agent name or key.
ID_GUARD = re.compile(r"(@thread\.|@unq\.gbl|^(?:8|19|28|29|48):|^a:1|"
                      r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.I)
_EXEC_TIME = re.compile(r"(\d+):(\d+):(\d+\.?\d*)")
_OUT_WS = re.compile(r"[\r\n\t]+")
# datetime.fromtimestamp's range (years 1 to 9999), in milliseconds.
_MS_MIN, _MS_MAX = -62135596800000, 253402300799999


def _safe_json(v):
    if not v:
        return None
    try:
        return json.loads(v)
    except Exception:  # noqa: BLE001 - anything unparseable is "no content"
        return None


def _clean_schema(val):
    """A bot schemaname only if it looks like a real schema token (no JSON characters or whitespace)."""
    if val is None:
        return None
    s = str(val).strip()
    if not s or len(s) > 128:
        return None
    if any(ch in s for ch in ("{", "}", '"', ":", "\n", "\t", " ", ",", "<", ">", "[", "]")):
        return None
    return s


def _clean_token(val, maxlen=200):
    """Like _clean_schema but allows spaces, colons and commas (display names are multi-word)."""
    if val is None:
        return None
    s = str(val).strip()
    if not s or len(s) > maxlen:
        return None
    if any(ch in s for ch in ("{", "}", '"', "\n", "\t", "<", ">", "[", "]")):
        return None
    return s


def _row_schema(rec):
    for c in ("bot_conversationtranscriptid.schemaname", "bot_schemaname", "schemaname"):
        if c in rec and rec.get(c) is not None:
            v = _clean_schema(rec.get(c))
            if v:
                return v
    nb = rec.get("bot_conversationtranscriptid")
    if isinstance(nb, dict):
        return _clean_schema(nb.get("schemaname"))
    return None


def keep_user_id(v):
    """The raw Entra object ID (kept so users join to org data); empty as None. Despite the column name
    `user_id_hash`, nothing is hashed."""
    if v is None or v == "":
        return None
    return str(v)


hash_id = keep_user_id


def pick_upn(frm):
    """A UPN-shaped identifier from a message `from` record, else None."""
    if not isinstance(frm, dict):
        return None
    for k in ("userPrincipalName", "upn", "email", "mail", "id", "aadObjectId"):
        v = frm.get(k)
        if isinstance(v, str):
            s = v.strip()
            if _UPN_OK.match(s) and not _UPN_NO.search(s):
                return s.lower()
    return None


def get_activities(content):
    if isinstance(content, dict):
        for k in ("activities", "Activities", "transcript", "messages"):
            if k in content and isinstance(content[k], list):
                return content[k]
    if isinstance(content, list):
        return content
    return []


# Defensive helpers: where the notebook would raise on malformed content (and lose a whole Spark task), these
# read the value as missing instead. Well-formed transcripts give exactly the notebook's rows.
def _dict(v):
    return v if isinstance(v, dict) else {}


def _iter(v):
    return v if isinstance(v, (list, dict, str)) else ()


def _len(v):
    try:
        return len(v)
    except TypeError:
        return 0


def _sliceable(v):
    if isinstance(v, (str, list)):
        return v
    return "" if v is None else str(v)


def _hashable(v):
    try:
        hash(v)
    except TypeError:
        return False
    return True


def _ms(ts):
    """A usable timestampMs, else None."""
    if not ts or not isinstance(ts, (int, float)):
        return None
    try:
        if isinstance(ts, float) and not math.isfinite(ts):
            return None
        return ts if _MS_MIN <= ts <= _MS_MAX else None
    except OverflowError:
        return None


def _iso(ms):
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _exec_ms(value) -> int:
    """An activity's executionTime (h:mm:ss.fff) in milliseconds; 0 if it isn't one."""
    m = _EXEC_TIME.match(str(value))
    if not m:
        return 0
    try:
        h, mn, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
        return int((h * 3600 + mn * 60 + s) * 1000)
    except (OverflowError, ValueError):
        return 0


def _role(a):
    return _dict(a.get("from")).get("role")


def _verdict_from_value(val):
    if val is None:
        return None
    if isinstance(val, bool):
        return "Positive" if val else "Negative"
    if isinstance(val, (int, float)):
        return "Positive" if val > 0 else "Negative"
    s = str(val).strip().lower()
    if s in ("true", "1", "like", "thumbsup", "thumbs up", "up", "positive", "helpful", "yes", "good", "smile"):
        return "Positive"
    if s in ("false", "0", "dislike", "thumbsdown", "thumbs down", "down", "negative", "unhelpful", "no", "bad",
             "frown"):
        return "Negative"
    return None


def extract_submitted_feedback(act_list):
    """(verdict, comment) from every place a completed feedback verdict lands in the activity stream."""
    verdict = None
    comment = None
    for a in act_list:
        if not isinstance(a, dict):
            continue
        for rx in _iter(a.get("reactionsAdded") or []):
            if isinstance(rx, dict):
                v = _verdict_from_value(rx.get("type") or rx.get("reactionType"))
                if v:
                    verdict = v
        cd = a.get("channelData") if isinstance(a.get("channelData"), dict) else {}
        fl = cd.get("feedbackLoop") if isinstance(cd.get("feedbackLoop"), dict) else {}
        if fl:
            v = _verdict_from_value(fl.get("value") or fl.get("reaction") or fl.get("vote"))
            if v:
                verdict = v
            comment = comment or fl.get("feedbackText") or fl.get("text")
        cf = cd.get("feedback") if isinstance(cd.get("feedback"), dict) else {}
        if cf:
            v = _verdict_from_value(cf.get("helpful") if "helpful" in cf else cf.get("reaction"))
            if v:
                verdict = v
            comment = comment or cf.get("feedbackText") or cf.get("text")
        val = a.get("value") if isinstance(a.get("value"), dict) else {}
        if val:
            action = str(val.get("actionName") or a.get("name") or "").lower()
            fb = val.get("feedback") if isinstance(val.get("feedback"), dict) else None
            if fb or "feedback" in action or "submitaction" in action:
                src = fb or val
                v = _verdict_from_value(src.get("helpful") if "helpful" in src
                                        else (src.get("reaction") or src.get("vote") or src.get("rating")))
                if v:
                    verdict = v
                comment = comment or src.get("feedbackText") or src.get("text")
    return verdict, comment


def resolve_agent_identity(acts, row):
    """(agent_schema, agent_name, agent_id, connected_schemas) from the most reliable signal: the Dataverse bot
    lookup, then the bot's from/recipient identity on messages, then orchestration traces, then the
    transcript's name."""
    connected, trace_schema = [], None
    for a in acts:
        if not isinstance(a, dict):
            continue
        v = a.get("value") or {}
        if not isinstance(v, dict):
            continue
        if a.get("valueType") == "ConnectedAgentInitializeTraceData":
            sn = v.get("connectedAgentBotSchemaName") or v.get("botSchemaName")
            if sn and sn not in connected:
                connected.append(sn)
            if trace_schema is None:
                trace_schema = v.get("parentBotSchemaName")
        elif trace_schema is None:
            bsn = v.get("botSchemaName") or v.get("parentBotSchemaName")
            if bsn:
                trace_schema = bsn

    lookup_schema = row.get("agent_schema_hint")
    lookup_name = lookup_id = None
    nbref = row.get("bot_conversationtranscriptid")
    if isinstance(nbref, dict):
        lookup_schema = lookup_schema or _clean_schema(nbref.get("schemaname"))
        lookup_name = _clean_token(nbref.get("name"))
        lookup_id = _clean_token(nbref.get("botid"))
    for c in ("bot_conversationtranscriptid.name", "bot_name"):
        if not lookup_name and c in row:
            lookup_name = _clean_token(row.get(c))
    for c in ("bot_conversationtranscriptid.botid", "botid", "bot_botid"):
        if not lookup_id and c in row:
            lookup_id = _clean_token(row.get(c))

    msg_name = msg_id = None
    for a in acts:
        if not isinstance(a, dict) or a.get("type") != "message":
            continue
        frm = _dict(a.get("from"))
        if frm.get("role") in (1, "bot"):
            msg_name = msg_name or _clean_token(frm.get("name"))
            msg_id = msg_id or _clean_token(frm.get("id"))
        else:
            rcp = a.get("recipient") or {}
            if isinstance(rcp, dict):
                msg_name = msg_name or _clean_token(rcp.get("name"))
                msg_id = msg_id or _clean_token(rcp.get("id"))
        if msg_name and msg_id:
            break

    tx_name = _clean_token(row.get("name"))
    schema = lookup_schema or trace_schema
    name = lookup_name or msg_name or tx_name
    if name and ID_GUARD.search(str(name)):
        name = None
    bot_id = lookup_id or msg_id
    if not schema:
        cand = name or bot_id
        schema = cand if (cand and not ID_GUARD.search(str(cand))) else None
    return schema, name, bot_id, connected


def _first_last_ms(acts):
    first = last = None
    for a in acts:
        ts = _ms(a.get("timestampMs")) if isinstance(a, dict) else None
        if ts:
            first = ts if first is None or ts < first else first
            last = ts if last is None or ts > last else last
    return first, last


# ------------------------------------------------------------------------------------------------- builders
def _session_row(r, acts, msgs, user_msgs, bot_msgs, identity):
    user_id_raw = user_upn_raw = None
    if user_msgs:
        frm = _dict(user_msgs[0].get("from"))
        user_id_raw = frm.get("aadObjectId") or frm.get("id")
        user_upn_raw = pick_upn(frm)
    primary_agent, agent_name, agent_bot_id, connected_agents = identity
    cost = latency = plan_steps = 0
    for a in acts:
        v = a.get("value") if isinstance(a, dict) else None
        if isinstance(v, dict) and "displayedCost" in v:
            try:
                cost += int(v.get("displayedCost") or 0)
            except (TypeError, ValueError, OverflowError):
                pass
            plan_steps += 1
            et = v.get("executionTime")
            if et:
                latency += _exec_ms(et)
    k_searched = k_answered = False
    k_sources = 0
    for a in acts:
        if isinstance(a, dict) and a.get("valueType") == "KnowledgeTraceData":
            v = a.get("value") or {}
            if isinstance(v, dict):
                if v.get("isKnowledgeSearched"):
                    k_searched = True
                if v.get("completionState") == "Answered":
                    k_answered = True
                k_sources += _len(v.get("citedKnowledgeSources") or [])
    g_internal = g_external = False
    for a in acts:
        if not isinstance(a, dict):
            continue
        vt = a.get("valueType")
        nm = str(a.get("name") or "")
        gv = a.get("value") or {}
        if vt == "KnowledgeTraceData" and isinstance(gv, dict) and gv.get("isKnowledgeSearched"):
            g_internal = True
        if "UniversalSearch" in nm and isinstance(gv, dict):
            if gv.get("knowledgeSources"):
                g_internal = True
            for ep in _iter(_dict(gv.get("searchContextTraceInfo")).get("endpoints") or []):
                h = str(ep).lower()
                if "bing.com" in h or "bing.net" in h:
                    g_external = True
                elif "sharepoint" in h or "onedrive" in h or "crm.dynamics" in h or "graph.microsoft" in h:
                    g_internal = True
                elif h.startswith("http"):
                    g_external = True
        if "web" in nm.lower() and "search" in nm.lower():
            g_external = True
    grounding_source = ("Mixed (Internal+Web)" if g_internal and g_external
                        else "External (Web)" if g_external
                        else "Internal" if g_internal
                        else "Ungrounded")
    errors = [_dict(a.get("value")).get("errorCode") or "Unknown"
              for a in acts if isinstance(a, dict) and a.get("valueType") == "ErrorTraceData"]
    feedback_offered = sum(1 for a in acts if isinstance(a, dict)
                           and isinstance(a.get("channelData"), dict) and "feedbackLoop" in a["channelData"])
    verdict, comment = extract_submitted_feedback(acts)
    first_ts, last_ts = _first_last_ms(acts)
    duration_ms = (last_ts - first_ts) if first_ts and last_ts else None
    session_start = _iso(first_ts) or r.get("conversationstarttime", "")
    first_prompt = ""
    for a in user_msgs:
        if a.get("text", ""):
            first_prompt = _sliceable(a["text"])[:TEXT_TRUNCATE]
            break
    return {
        "conversation_id": r.get("conversationtranscriptid", ""),
        "session_start_utc": session_start,
        "session_duration_ms": duration_ms,
        "user_id_hash": hash_id(user_id_raw),
        "user_upn": user_upn_raw,
        "primary_agent_schema": primary_agent,
        "connected_agent_schemas": "|".join(str(c) for c in connected_agents) if connected_agents else None,
        "connected_agent_count": len(connected_agents),
        "agent_name": agent_name,
        "agent_id": agent_bot_id,
        "msg_count": len(msgs),
        "user_msg_count": len(user_msgs),
        "bot_msg_count": len(bot_msgs),
        "plan_step_count": plan_steps,
        "total_displayed_cost": cost,
        "total_latency_ms": latency,
        "knowledge_searched": k_searched,
        "knowledge_answered": k_answered,
        "knowledge_sources_count": k_sources,
        "grounding_source": grounding_source,
        "error_count": len(errors),
        "first_error_code": errors[0] if errors else None,
        "feedback_offered_count": feedback_offered,
        "feedback_submitted": 1 if verdict else 0,
        "feedback_verdict": verdict,
        "feedback_comment": comment,
        "first_user_prompt": first_prompt,
        "session_outcome_explicit": None,
        "session_outcome_reason_explicit": None,
        "is_authenticated": bool(user_id_raw),
        "is_returning_user": None,  # needs every session: the collector sets it after the merge
        "primary_topic_derived": None,
    }


def _turn_rows(r, acts):
    conv_id = r.get("conversationtranscriptid", "")
    intent_by_reply, knowledge_by_reply = {}, {}
    for a in acts:
        if not isinstance(a, dict):
            continue
        rid = a.get("replyToId")
        if not rid or not _hashable(rid):
            continue
        v = a.get("value") or {}
        if not isinstance(v, dict):
            continue
        if a.get("valueType") == "IntentRecognition":
            # intentScore is a bare number or {"score": n}, depending on the Copilot Studio version.
            score = v.get("intentScore")
            if isinstance(score, dict):
                score = score.get("score")
            intent_by_reply[rid] = {"intent_title": v.get("intentTitle"), "intent_id": v.get("intentId"),
                                    "intent_score": score}
        if a.get("valueType") == "KnowledgeTraceData":
            knowledge_by_reply[rid] = {
                "knowledge_searched": bool(v.get("isKnowledgeSearched")),
                "knowledge_answered": v.get("completionState") == "Answered",
                "knowledge_sources": "|".join(str(x) for x in _iter(v.get("citedKnowledgeSources") or [])),
            }
    rows = []
    for a in acts:
        if not isinstance(a, dict) or a.get("type") != "message":
            continue
        frm = _dict(a.get("from"))
        role = frm.get("role")
        role_label = "user" if role in (0, "user") else ("bot" if role in (1, "bot") else "other")
        from_id = frm.get("aadObjectId") or frm.get("id")
        msg_id = a.get("id")
        hashable = _hashable(msg_id)
        intent = intent_by_reply.get(msg_id, {}) if hashable else {}
        knowledge = knowledge_by_reply.get(msg_id, {}) if hashable else {}
        cd = a.get("channelData") or {}
        fb_offered = isinstance(cd, dict) and "feedbackLoop" in cd
        turn_verdict, turn_comment = extract_submitted_feedback([a])
        text = _sliceable(a.get("text") or "")
        rows.append({
            "conversation_id": conv_id,
            "turn_id": msg_id,
            "turn_timestamp_utc": _iso(_ms(a.get("timestampMs"))),
            "turn_role": role_label,
            "turn_channel": a.get("channelId"),
            "from_user_hash": hash_id(from_id) if role_label == "user" else None,
            "text_preview_500": text[:TEXT_TRUNCATE],
            "text_length": len(text),
            "intent_title": intent.get("intent_title"),
            "intent_id": intent.get("intent_id"),
            "intent_score": intent.get("intent_score"),
            "knowledge_searched": knowledge.get("knowledge_searched"),
            "knowledge_answered": knowledge.get("knowledge_answered"),
            "knowledge_sources": knowledge.get("knowledge_sources"),
            "feedback_offered": fb_offered,
            "feedback_verdict": turn_verdict,
            "feedback_comment": turn_comment,
        })
    return rows


def _error_rows(r, acts):
    rows = []
    for a in acts:
        if not isinstance(a, dict) or a.get("valueType") != "ErrorTraceData":
            continue
        v = _dict(a.get("value"))
        rows.append({
            "conversation_id": r.get("conversationtranscriptid", ""),
            "error_timestamp_utc": _iso(_ms(a.get("timestampMs"))),
            "error_code": v.get("errorCode"),
            "error_sub_code": v.get("errorSubCode"),
            "error_message": _sliceable(v.get("errorMessage") or "")[:TEXT_TRUNCATE],
            "is_user_error": bool(v.get("isUserError")),
        })
    return rows


def _subagent_rows(r, acts):
    rows = []
    for a in acts:
        if not isinstance(a, dict):
            continue
        vt = a.get("valueType")
        if vt not in ("ConnectedAgentInitializeTraceData", "ConnectedAgentCompletedTraceData"):
            continue
        v = _dict(a.get("value"))
        rows.append({
            "conversation_id": r.get("conversationtranscriptid", ""),
            "invocation_timestamp_utc": _iso(_ms(a.get("timestampMs"))),
            "event_type": "initialize" if vt.endswith("InitializeTraceData") else "completed",
            "parent_agent_schema": v.get("parentBotSchemaName"),
            "connected_agent_schema": v.get("connectedAgentBotSchemaName") or v.get("botSchemaName"),
            "dialog_schema": v.get("dialogSchemaName"),
            "user_id_hash": hash_id(v.get("userId")),
            "plan_step_id": v.get("planStepId"),
        })
    return rows


def _performance_row(r, acts, msgs, user_msgs, bot_msgs, identity):
    primary_agent, _agent_name, agent_bot_id, connected_agents = identity
    topics, last_intent_id = [], None
    for a in acts:
        if isinstance(a, dict) and a.get("valueType") == "IntentRecognition":
            v = _dict(a.get("value"))
            t = v.get("intentTitle")
            if t and t not in topics:
                topics.append(t)
            last_intent_id = v.get("intentId") or last_intent_id
    sys_error = user_error = False
    for a in acts:
        if isinstance(a, dict) and a.get("valueType") == "ErrorTraceData":
            if _dict(a.get("value")).get("isUserError"):
                user_error = True
            else:
                sys_error = True
    latency_total = plan_steps = trace_count = event_count = 0
    for a in acts:
        if not isinstance(a, dict):
            continue
        if a.get("type") == "trace":
            trace_count += 1
        elif a.get("type") == "event":
            event_count += 1
        v = a.get("value") if isinstance(a.get("value"), dict) else None
        if v and "executionTime" in v:
            plan_steps += 1
            latency_total += _exec_ms(v.get("executionTime"))
    try:
        avg_latency = int(latency_total / plan_steps) if plan_steps else 0
    except OverflowError:
        avg_latency = latency_total // plan_steps
    first_ts, last_ts = _first_last_ms(acts)
    duration_s = int((last_ts - first_ts) / 1000) if first_ts and last_ts else 0

    def _txt(a):
        return _sliceable(a.get("text") or "")[:TEXT_TRUNCATE] if isinstance(a, dict) else ""

    upn = None
    for a in acts:
        if not isinstance(a, dict):
            continue
        v = a.get("value") if isinstance(a.get("value"), dict) else {}
        vars_ = v.get("variables") if isinstance(v.get("variables"), dict) else {}
        upn = upn or vars_.get("ESS_UserContext_UPN") or vars_.get("Var_ESS_UserContext_UPN")

    # Documented heuristics (as Fabric): the model derives the rest in DAX.
    engaged = bool(topics) or len(bot_msgs) > 0
    session_type = "Engaged" if engaged else "Unengaged"
    if connected_agents:
        outcome = "Escalated"
    elif not engaged or (len(user_msgs) > 0 and len(bot_msgs) == 0) or (sys_error and len(bot_msgs) == 0):
        outcome = "Abandoned"
    else:
        outcome = "Resolved"
    outcome_reason = ("SystemError" if sys_error else "UserError" if user_error else
                      ("Escalated" if outcome == "Escalated" else
                       "Abandoned" if outcome == "Abandoned" else "Completed"))
    implied_success = "TRUE" if (outcome == "Resolved" and not sys_error) else "FALSE"
    start_iso = _iso(first_ts) or r.get("conversationstarttime", "")
    end_iso = _iso(last_ts) or ""
    error_codes = [_dict(a.get("value")).get("errorCode")
                   for a in acts if isinstance(a, dict) and a.get("valueType") == "ErrorTraceData"]
    first_error = next((e for e in error_codes if e), None)
    authenticated = any(_dict(a.get("from")).get("aadObjectId") for a in user_msgs)
    multi_agent = any(_dict(a.get("value") or {}).get("connectedAgentBotSchemaName")
                      for a in acts if isinstance(a, dict))
    generative = sum(1 for a in acts if isinstance(a, dict)
                     and a.get("valueType") in ("GenerativeAIResponseTraceData", "GenerativeResponseTraceData"))
    return {
        "ConversationTranscriptId": r.get("conversationtranscriptid", ""),
        "ConversationStartTime": r.get("conversationstarttime", "") or start_iso,
        "SchemaVersion": r.get("schemaversion", ""),
        "BotName": primary_agent or "",
        "BotId": agent_bot_id or r.get("botid", ""),
        "AADTenantId": r.get("aadtenantid", ""),
        "BatchId": r.get("batchid", ""),
        "SessionStartTimeUtc": start_iso,
        "SessionEndTimeUtc": end_iso,
        "SessionType": session_type,
        "SessionOutcome": outcome,
        "TurnCount": len(msgs),
        "OutcomeReason": outcome_reason,
        "ImpliedSuccess": implied_success,
        "LastUserIntentId": last_intent_id,
        "IsDesignMode": "FALSE",
        "Locale": r.get("locale", ""),
        "UserMessageCount": len(user_msgs),
        "BotMessageCount": len(bot_msgs),
        "TotalMessageCount": len(msgs),
        "FirstUserMessage": _txt(user_msgs[0]) if user_msgs else "",
        "LastUserMessage": _txt(user_msgs[-1]) if user_msgs else "",
        "FirstBotMessage": _txt(bot_msgs[0]) if bot_msgs else "",
        "LastBotMessage": _txt(bot_msgs[-1]) if bot_msgs else "",
        "TopicsTriggered": "|".join(str(t) for t in topics) if topics else "",
        "TopicCount": len(topics),
        "PrimaryTopic": topics[0] if topics else "",
        "DurationSeconds": duration_s,
        "AverageLatencyMs": avg_latency,
        "Var_ESS_UserContext_UPN": upn,
        "Var_ESS_Message_Disclaimer": "",
        "Var_ESS_UserContext_RefreshInterval_Hours": "",
        "Var_ESS_UserContext_Conversation_Initialized": "",
        "AllVariables": "",
        "TotalActivityCount": len(acts),
        "TraceActivityCount": trace_count,
        "EventActivityCount": event_count,
        "StatusCode": 1 if outcome == "Resolved" else 0,
        "StateCode": 1,
        "FirstErrorCode": first_error,
        "ErrorCategory": None,
        "IsAuthenticated": "TRUE" if authenticated else "FALSE",
        "MultiAgentSession": "TRUE" if multi_agent else "FALSE",
        "SessionOutcomeExplicit": None,
        "SessionOutcomeReasonExplicit": None,
        "GenerativeResponseCount": generative,
        "LLMCallCount": None,
        "PromptTokenCount": None,
        "CompletionTokenCount": None,
        "TotalTokenCount": None,
        "PluginCallCount": None,
        "PluginSuccessCount": None,
        "TopicsStarted": len(topics),
        "TopicsCompleted": None,
        "TopicCompletionRate": None,
        "PrimaryTopicDwellMs": None,
        "TotalTopicDwellMs": None,
    }


def transcript_rows(r) -> dict:
    """{fact table: [raw rows]} for one parsed transcript (`r` carries content_json and agent_schema_hint)."""
    acts = get_activities(r["content_json"])
    msgs = [a for a in acts if isinstance(a, dict) and a.get("type") == "message"]
    user_msgs = [a for a in msgs if _role(a) in (0, "user")]
    bot_msgs = [a for a in msgs if _role(a) in (1, "bot")]
    identity = resolve_agent_identity(acts, r)
    return {
        "agent_sessions": [_session_row(r, acts, msgs, user_msgs, bot_msgs, identity)],
        "agent_turns": _turn_rows(r, acts),
        "agent_errors": _error_rows(r, acts),
        "agent_subagents": _subagent_rows(r, acts),
        "agent_performance": [_performance_row(r, acts, msgs, user_msgs, bot_msgs, identity)],
    }


# ---------------------------------------------------------------------------------------------- output values
def out_str(v):
    """One output value as the notebook's Delta tables store it: None stays None (as does NaN); embedded
    newlines/tabs collapse to a space; whole floats lose their '.0'."""
    if v is None:
        return None
    if isinstance(v, (list, tuple, dict, set)):
        return str(v)
    if isinstance(v, float):
        if math.isnan(v):
            return None
        return str(int(v)) if v.is_integer() else str(v)
    if isinstance(v, str):
        return _OUT_WS.sub(" ", v).strip()
    return str(v)


def transcript_date(value):
    """The UTC day a conversation started, from its conversationstarttime ('YYYY-MM-DD...'), else None."""
    text = str(value or "")[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return None
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        return None


def parse_records(records) -> tuple[dict, dict]:
    """Staged records -> ({fact table: [rows of strings]}, stats).

    A record is dropped (and counted) when its content isn't JSON (`valid`) or its id isn't a GUID (`corrupt`);
    `hint` counts records whose bot lookup gave a schema. A transcript whose content still breaks a builder is
    skipped whole and counted in `failed` (with up to five samples in `failures`), so one bad record can't
    stop a run. Must stay picklable: the collector runs it in worker processes."""
    stats = {"rows": 0, "valid": 0, "corrupt": 0, "hint": 0, "failed": 0, "failures": []}
    out = {t: [] for t in FACT_TABLES}
    for raw in records:
        stats["rows"] += 1
        rec = {k: ("" if v is None else v) for k, v in raw.items()}
        nb = rec.get("bot_conversationtranscriptid")
        if isinstance(nb, str) and nb.startswith("{"):
            rec["bot_conversationtranscriptid"] = _safe_json(nb) or nb
        content = _safe_json(rec.get("content"))
        if content is None or (isinstance(content, float) and math.isnan(content)):
            continue
        stats["valid"] += 1
        if not _TRANSCRIPT_ID_RE.match(str(rec.get("conversationtranscriptid", "")).strip()):
            stats["corrupt"] += 1
            continue
        rec["content_json"] = content
        rec["agent_schema_hint"] = _row_schema(rec)
        if rec["agent_schema_hint"] is not None:
            stats["hint"] += 1
        try:
            built = transcript_rows(rec)
        except Exception as exc:  # noqa: BLE001 - one malformed transcript must not stop the run
            stats["failed"] += 1
            if len(stats["failures"]) < 5:
                stats["failures"].append(f"{rec.get('conversationtranscriptid')}: {type(exc).__name__}: {exc}"[:300])
            continue
        env = out_str(raw.get("SourceEnvironment"))
        day = transcript_date(raw.get("conversationstarttime"))
        for table, rows in built.items():
            for row in rows:
                row = {k: out_str(v) for k, v in row.items()}
                row["source_environment"] = env
                row["transcript_date"] = day
                out[table].append(row)
    return out, stats


def encode_chunk(records) -> tuple[dict, dict, dict]:
    """parse_records, with each table's rows as gzip-compressed JSON lines: ({table: bytes}, {table: rows},
    stats). The collector's worker processes return this (far smaller than the rows) and it's appended to
    the spool files as is. Text that can't be UTF-8 (a lone surrogate) becomes '?'."""
    out, stats = parse_records(records)
    blobs, counts = {}, {}
    for table, rows in out.items():
        counts[table] = len(rows)
        data = b"".join(json.dumps(r, ensure_ascii=False).encode("utf-8", "replace") + b"\n" for r in rows)
        blobs[table] = gzip.compress(data, compresslevel=1, mtime=0) if data else b""
    return blobs, counts, stats


# ------------------------------------------------------------------------------------------- agent catalogue
# Curated friendly labels: 'schemaname': 'Friendly Name'.
AGENT_DESCRIPTIONS = {
    "msdyn_copilotforemployeeselfservicehr": "Employee Self-Service HR",
    "msdyn_copilotforemployeeselfserviceit": "Employee Self-Service IT",
    "msdyn_copilotforemployeeselfservicefinance": "Employee Self-Service Finance",
    "msdyn_copilotforemployeeselfservicegeneral": "Employee Self-Service General",
}
# Orchestrator / header agents collapse to one label so they cluster in the Agent Evaluation visuals.
ORCHESTRATOR_LABEL = "M365 Copilot Orchestrator"
_PUBLISHER_PREFIX = re.compile(r"^(?:[a-z][a-z0-9]{1,7}|copilots_header|copilots|copilot)_", re.I)
_ACRONYMS = {"BT", "HR", "IT", "AI", "HQ", "QA", "CRM", "ERP", "M365", "API", "KPI", "PDF", "SLA", "VPN"}


def _is_orchestrator(schema):
    s = str(schema or "").lower()
    return "header" in s or "orchestrator" in s


def _selfservice_label(key):
    m = re.search(r"copilotforemployeeselfservice([a-z]+)", key)
    suffix = m.group(1) if m else ""
    if not suffix:
        return "Employee Self-Service"
    label = suffix.upper() if suffix.upper() in _ACRONYMS else suffix.capitalize()
    return f"Employee Self-Service {label}"


def humanise_schema(schema):
    """A readable label from a raw Dataverse schemaname when no friendly bot name is available."""
    if not schema:
        return "Unknown agent"
    s = str(schema)
    core = _PUBLISHER_PREFIX.sub("", s)
    core = re.sub(r"[_\-]+", " ", core)
    core = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", core).strip()
    if not core:
        return "Unknown agent"
    compact = core.replace(" ", "")
    if re.fullmatch(r"(?:agent)?[0-9a-f]{4,}", compact, re.I) or re.fullmatch(r"agent[0-9a-z]{3,}", compact, re.I):
        tail = re.sub(r"^agent", "", compact, flags=re.I)
        return f"Agent {tail}" if tail else "Agent"
    words = []
    for w in core.split():
        if w.upper() in _ACRONYMS:
            words.append(w.upper())
        elif w.isupper():
            words.append(w)
        else:
            words.append(w.capitalize())
    return " ".join(words) or f"Agent {s}"


def display_name(schema, name_map):
    """Orchestrator cluster -> curated label -> real bot name -> self-service pattern -> humanised token."""
    if _is_orchestrator(schema):
        return ORCHESTRATOR_LABEL
    key = str(schema).lower()
    if key in AGENT_DESCRIPTIONS:
        return AGENT_DESCRIPTIONS[key]
    nm = name_map.get(schema)
    if nm and nm.strip().lower() != key and not ID_GUARD.search(str(nm)):
        return nm.strip()
    if "copilotforemployeeselfservice" in key:
        return _selfservice_label(key)
    if ID_GUARD.search(str(schema)):
        return "Unknown agent"
    return humanise_schema(schema)


def classify(schema):
    s = str(schema).lower()
    if "header" in s or "orchestrator" in s:
        return "Orchestrator"
    if "copilotforemployeeselfservice" in s:
        return "Self-Service"
    if s.startswith("crb") or s.startswith("crd"):
        return "Custom Declarative"
    if s.startswith("msdyn"):
        return "First-Party Connected"
    return "Other"


def catalogue_rows(schemas, named, envs_by_schema) -> list[dict]:
    """agent_catalogue: one row per agent schema seen in sessions or sub-agent calls.

    `named` is (schema, agent_name) pairs, the name from each agent's most recent session first; the first
    usable name per schema wins. `envs_by_schema` maps a schema to its '|'-joined environments."""
    name_map = {}
    for sc, nm in named:
        if sc is not None and sc not in name_map and isinstance(nm, str) and nm.strip():
            name_map[sc] = nm.strip()
    rows = []
    for s in sorted({s for s in schemas if s is not None}):
        rows.append({
            "agent_schema": out_str(s),
            "agent_display_name": out_str(display_name(s, name_map)),
            "agent_class": out_str(classify(s)),
            "source_environments": out_str(envs_by_schema.get(s) or ""),
        })
    return rows


# ------------------------------------------------------------------------------------- what each run read
def status_of_error(e) -> str:
    code = getattr(getattr(e, "response", None), "status_code", None) or getattr(e, "status_code", None)
    text = str(e)
    if code in (401, 403) or "AADSTS" in text or "401" in text or "403" in text:
        return "forbidden"
    return "error"


def evaluator_status_rows(environments, env_ids, bad_envs, errs, env_days, names, run_at):
    """(RunAt, Environment, EnvironmentUrl, LookbackDays, Transcripts, Status, Reason) per environment.
    env_ids maps each environment URL to the distinct transcript ids read from it; errs is ((url, ...), error)
    per failed window. Unlike Fabric, an environment that read transcripts but lost a window says so."""
    out = []
    for env in environments:
        url = env.rstrip("/")
        name = names.get(url) or names.get(env) or url.split("//")[-1]
        days = int(env_days.get(url) or 0)
        span = f"the last {days} days" if days else "all time"
        failed = [e for (t, e) in errs if t[0].rstrip("/") == url]
        bad = bad_envs.get(env) or bad_envs.get(url)
        count = len(env_ids.get(url, ()))
        if bad is not None:
            status, reason = status_of_error(bad), f"Couldn't sign in to the environment: {str(bad)[:300]}"
        elif failed and not count:
            status, reason = status_of_error(failed[0]), f"Couldn't read transcripts: {str(failed[0])[:300]}"
        elif count:
            status, reason = "ok", f"{count:,} transcripts in {span}"
            if failed:
                reason += f" ({len(failed)} read window(s) failed; the next run reads them again)"
        else:
            status, reason = "empty", f"0 transcripts found in {span}"
        out.append((run_at, name, url, days, count, status, reason))
    return out


# --------------------------------------------------------------------------------------------- read windows
def _fmt(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def windows(days, n, now: datetime) -> list[tuple]:
    """Half-open [start, end) slices on conversationstarttime, pulled in parallel. No lookback is one unbounded
    slice (a full pull). The last slice is open-ended so it catches rows up to the moment it's read."""
    n = max(1, int(n))
    if not days or days <= 0:
        return [(None, None)]
    start = now - timedelta(days=int(days))
    if n == 1:
        return [(_fmt(start), None)]
    step = (now - start) / n
    edges = [start + step * i for i in range(n)] + [now]
    return [(_fmt(edges[i]), None if i == n - 1 else _fmt(edges[i + 1])) for i in range(n)]


def _parse_time(value):
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def env_lookback(last_success, now: datetime, lookback, first_read) -> int:
    """Days to read from one environment. A lookback of 0 (or less) is a full pull every run. An environment no
    run has finished reading goes back max(lookback, first_read) days; otherwise the lookback stretches to
    cover the gap since its last complete read, up to that same depth."""
    lookback = int(lookback or 0)
    if lookback <= 0:
        return 0
    cap = max(lookback, int(first_read or 0))
    last = _parse_time(last_success) if last_success else None
    if last is None:
        return cap
    gap = math.ceil(max(0.0, (now - last).total_seconds()) / 86400) + 1
    return max(lookback, min(gap, cap))
