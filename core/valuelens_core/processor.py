"""DuckDB port of the Fabric `Copilot_Audit_Log_Processor` notebook (cells 3-14).

`curate()` turns the parsed audit-log fact (plus optional licensed-users and Agents 365
dimensions) into the flat `copilot_interactions_curated` table the semantic model reads.
It mirrors the Spark notebook step for step, including column order, types and Spark's
null / JSON semantics, and is held to it by the golden parity tests in
`tests/test_valuelens_core_parity.py`. Change the notebook and this module together.
The notebook's pure-Python agent link and agent type rules (cell 2) are copied verbatim
into `agent_link.py` and `agent_type.py`.
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from typing import Iterable, Optional, Sequence, Union

import duckdb

from .agent_link import (BARE_GUID_PATTERN, EXCLUDE_REASON_SQL, PLATFORM_AGENT_ID_PATTERN,
                         TITLE_SCHEMA_PATTERN, build_agent_link_maps, build_schema_title_map,
                         resolve_agent_link)
from .agent_type import build_agent_type_overrides, describe_agent

DEFAULT_AGENT_IDENTITY_PATTERNS = (r"^securitycopilotagentuser-",)

# Exclude_Reason values whose rows are dropped (notebook cell 1, DROP_EXCLUDE_REASONS).
DEFAULT_DROP_EXCLUDE_REASONS = (
    "Copilot Studio test pane",
    "Maker evaluation",
    "Agent authoring",
    "Autonomous run",
    "Workflow run",
    "M365 Copilot twin",
    "Fabric multi-agent",
)

RAW_PASSTHROUGH_COLUMNS = {
    "AppIdentity": "AppIdentity_Raw",
    "AccessedResources": "AccessedResources_Raw",
    "AISystemPlugin": "AISystemPlugin_Raw",
}

REQUIRED_TEXT_COLS = [
    "AISystemPlugin_Id", "AISystemPlugin_Name",
    "AccessedResource_Action", "AccessedResource_SensitivityLabelId",
    "AccessedResource_SiteUrl", "AccessedResource_Type",
    "AgentId", "AgentName", "Agent_EntraId", "Agent_LinkID", "Agent_TitleID",
    "AppHost", "AppIdentity_AppId", "AppIdentity_DisplayName", "AppIdentity_PublisherId",
    "ApplicationName", "Audit_UserId", "Audit_UserKey", "ClientRegion", "Context_Type",
    "Has license", "Message_Id", "Message_isPrompt",
    "ModelTransparencyDetails_ModelName", "ModelTransparencyDetails_ModelProviderName",
    "SensitivityLabelId", "ThreadId", "Workload",
]
# Agent-link and runtime columns added after the original contract.
AGENT_LINK_TEXT_COLS = [
    "Agent_BotId", "Agent_EnvironmentId", "Agent_MatchedTitleID", "Agent_LinkMethod",
    "AgentPlatform", "PlatformAgentId", "Prompts_Available", "Exclude_Reason",
]

AGENT_TYPE_COLS = ["Agent_Key", "Agent_Type", "Agent_Type_Basis", "Agent_Publisher",
                   "Agent_Is_Published", "Agent_Consolidated_Name"]

ENRICHED_COLS = [
    "Environment", "License Status", "Is_Sensitive", "AI_Model", "Behavior_Category",
    "Behavior_Enriched", "Behavior_Enriched_Full", "Behavior_Source", "Value_Outcome", "Usage_Mode",
    "Expertise_Role", "Efficiency_Breakdown", "Web_Grounded_Signal", "Behavior_Plausible", "Workflow_Action",
    "Is_Agent_Activity", "Agent Filter", "Grounding Source", "Agent_Surface", "Execution_Trigger",
    "UserMonthKey", "Delegation_Event_Key", "ActivityDate", "Agent Last Used Date",
    "User_Stage_Maturity", "User_Stage",
] + AGENT_TYPE_COLS

Source = Union[str, duckdb.DuckDBPyRelation, None]


# ---------------------------------------------------------------------------
# SQL building blocks. Plain `str` values are literals; `E` values are SQL.
# ---------------------------------------------------------------------------
class E(str):
    """A SQL expression (as opposed to a string literal)."""


def q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def lit(value) -> E:
    if value is None:
        return E("CAST(NULL AS VARCHAR)")
    if isinstance(value, E):
        return value
    if isinstance(value, bool):
        return E("TRUE" if value else "FALSE")
    return E("'" + str(value).replace("'", "''") + "'")


def col(name: str) -> E:
    return E(q(name))


def s_(expr) -> E:
    return E(f"CAST({expr} AS VARCHAR)")


def trim(expr) -> E:
    # Spark's trim() strips spaces only (not tabs/newlines).
    return E(f"trim({expr}, ' ')")


def chain(pairs, default) -> E:
    parts = " ".join(f"WHEN {c} THEN {lit(v)}" for c, v in pairs)
    return E(f"(CASE {parts} ELSE {lit(default)} END)")


def when(cond, value, otherwise=None) -> E:
    return E(f"(CASE WHEN {cond} THEN {lit(value)} ELSE {lit(otherwise)} END)")


def and_(*xs) -> E:
    return E("(" + " AND ".join(str(x) for x in xs) + ")")


def or_(*xs) -> E:
    return E("(" + " OR ".join(str(x) for x in xs) + ")")


def not_(x) -> E:
    return E(f"(NOT {x})")


def eq(a, b) -> E:
    return E(f"({a} = {lit(b)})")


def ne(a, b) -> E:
    return E(f"({a} <> {lit(b)})")


def contains(expr, sub: str) -> E:
    return E(f"contains({expr}, {lit(sub)})")


def has(expr, subs: Iterable[str]) -> E:
    # Spark: F.lit(False) | c.contains(s1) | ...
    return or_("FALSE", *[contains(expr, s) for s in subs])


def isin(expr, vals: Iterable[str]) -> E:
    return E(f"({expr} IN ({', '.join(lit(v) for v in vals)}))")


def in_lower(expr, vals: Iterable[str]) -> E:
    return isin(expr, [v.lower() for v in vals])


def coalesce(*xs) -> E:
    return E("coalesce(" + ", ".join(lit(x) for x in xs) + ")")


def low(name: str) -> E:       # lower+trim, null -> ""
    return E(f"lower({trim(coalesce(s_(col(name)), ''))})")


def raw(name: str) -> E:       # trim, null -> "" (case preserved)
    return trim(coalesce(s_(col(name)), ""))


def notblank(name: str) -> E:
    return and_(f"{col(name)} IS NOT NULL", ne(trim(s_(col(name))), ""))


def clean(name: str) -> E:     # trimmed value, or NULL when blank
    t = trim(s_(col(name)))
    return E(f"(CASE WHEN {t} IS NOT NULL AND {t} <> '' THEN {t} END)")


def concat(*xs) -> E:
    # Spark concat(): NULL if any input is NULL (same as DuckDB's ||, not concat()).
    return E("(" + " || ".join(lit(x) for x in xs) + ")")


def first_existing(columns: Sequence[str], candidates: Iterable[str]) -> Optional[str]:
    for c in candidates:
        if c in columns:
            return c
    return None


def agent_identity_regex(enabled: bool, patterns) -> Optional[str]:
    parts = [p.strip() for p in (patterns or []) if p and p.strip()]
    if not enabled or not parts:
        return None
    return "|".join(f"(?:{p})" for p in parts)


# ---------------------------------------------------------------------------
# A tiny DataFrame-like wrapper: every step is a DuckDB view over the last one,
# so withColumn / drop / join keep Spark's column order exactly.
# ---------------------------------------------------------------------------
class Frame:
    def __init__(self, con: duckdb.DuckDBPyConnection, source: str, prefix: str):
        self.con, self.prefix, self.objects, self.n = con, prefix, [], 0
        self.name = self._new("VIEW", f"SELECT * FROM {source}")

    def _new(self, kind: str, sql: str) -> str:
        self.n += 1
        name = f"{self.prefix}_{self.n}"
        self.con.execute(f"CREATE TEMP {kind} {q(name)} AS {sql}")
        self.objects.append((kind, name))
        return name

    def step(self, sql: str) -> "Frame":
        self.name = self._new("VIEW", sql)
        return self

    def checkpoint(self) -> "Frame":
        self.name = self._new("TABLE", f"SELECT * FROM {q(self.name)}")
        return self

    @property
    def rel(self) -> duckdb.DuckDBPyRelation:
        return self.con.sql(f"SELECT * FROM {q(self.name)}")

    @property
    def columns(self):
        return self.rel.columns

    def type_of(self, name: str) -> str:
        rel = self.rel
        return str(rel.types[rel.columns.index(name)])

    def has(self, name: str) -> bool:
        return name in self.columns

    def select(self, items) -> "Frame":
        return self.step(f"SELECT {', '.join(items)} FROM {q(self.name)}")

    def with_col(self, name: str, expr) -> "Frame":
        cols = self.columns
        items = [f"{expr} AS {q(c)}" if c == name else q(c) for c in cols]
        if name not in cols:
            items.append(f"{expr} AS {q(name)}")
        return self.select(items)

    def ensure(self, name: str, default=None, dtype: str = "VARCHAR") -> "Frame":
        if self.has(name):
            return self
        return self.with_col(name, f"CAST({lit(default)} AS {dtype})")

    def drop(self, *names) -> "Frame":
        cols = self.columns
        keep = [q(c) for c in cols if c not in names]
        if len(keep) == len(cols):
            return self
        return self.select(keep)

    def rename(self, old: str, new: str) -> "Frame":
        if not self.has(old):
            return self
        return self.select([f"{q(c)} AS {q(new)}" if c == old else q(c) for c in self.columns])

    def where(self, cond) -> "Frame":
        return self.step(f"SELECT * FROM {q(self.name)} WHERE {cond}")

    def left_join(self, right_sql: str, left_key: str, right_key: str, right_cols) -> "Frame":
        return self.left_join_on(right_sql, f"__l.{q(left_key)} = __r.{q(right_key)}", right_cols)

    def left_join_on(self, right_sql: str, on: str, right_cols) -> "Frame":
        items = [f"__l.{q(c)}" for c in self.columns] + [f"__r.{q(c)}" for c in right_cols]
        return self.step(
            f"SELECT {', '.join(items)} FROM {q(self.name)} AS __l "
            f"LEFT JOIN ({right_sql}) AS __r ON {on}")

    def values_table(self, columns, rows, batch: int = 500) -> str:
        """A temp table holding Python rows; `columns` is [(name, duckdb type), ...]."""
        name = self._new("TABLE", "SELECT " + ", ".join(
            f"CAST(NULL AS {t}) AS {q(c)}" for c, t in columns) + " WHERE FALSE")
        row_ph = "(" + ", ".join("?" for _ in columns) + ")"
        rows = list(rows)
        for i in range(0, len(rows), batch):
            chunk = rows[i:i + batch]
            self.con.execute(f"INSERT INTO {q(name)} VALUES {', '.join(row_ph for _ in chunk)}",
                             [v for r in chunk for v in r])
        return name

    def cleanup(self):
        for kind, name in reversed(self.objects):
            self.con.execute(f"DROP {kind} IF EXISTS {q(name)}")


def _register(con, source: Source, name: str) -> Optional[str]:
    if source is None:
        return None
    if isinstance(source, duckdb.DuckDBPyRelation):
        source.create_view(name, replace=True)
        return q(name)
    return source


def _columns(con, source: Optional[str]):
    if source is None:
        return None
    try:
        return con.sql(f"SELECT * FROM {source} LIMIT 0").columns
    except duckdb.Error:
        return None   # Spark: spark.table() raised -> dimension treated as absent


def _creation_ts(ctype: str) -> E:
    # CreationDate as a UTC TIMESTAMP, whatever type the parsed source stored it as.
    if ctype == "TIMESTAMP":
        return col("CreationDate")
    if ctype.startswith("TIMESTAMP WITH TIME ZONE"):
        return E(f"timezone('UTC', {col('CreationDate')})")
    if ctype == "DATE":
        return E(f"CAST({col('CreationDate')} AS TIMESTAMP)")
    return E(f"CAST(TRY_CAST({s_(col('CreationDate'))} AS TIMESTAMPTZ) AS TIMESTAMP)")


def creation_timestamp_sql(con, source: str) -> Optional[str]:
    """SQL for each source row's CreationDate as a UTC TIMESTAMP, exactly as curate() reads it.

    curate() derives InteractionDate/MonthStart from this value, so an incremental run can
    bucket source rows by month the same way. Sets the connection's TimeZone to UTC, as
    curate() does. None when the source has no CreationDate column.
    """
    con.execute("SET TimeZone = 'UTC'")
    rel = con.sql(f"SELECT * FROM {source} LIMIT 0")
    if "CreationDate" not in rel.columns:
        return None
    return str(_creation_ts(str(rel.types[rel.columns.index("CreationDate")])))


def _as_text(f: "Frame", name: str) -> E:
    t = f.type_of(name)
    if t.startswith(("STRUCT", "MAP")) or t.endswith("]"):
        return E(f"CAST(to_json({col(name)}) AS VARCHAR)")
    return s_(col(name))


# ---------------------------------------------------------------------------
# JSON helpers replicating Spark from_json(..., array<struct<string fields>>).
# Spark keeps an array only if every element is an object or null, wraps a bare
# object into [obj], and returns NULL for anything else (scalars, invalid JSON).
# ---------------------------------------------------------------------------
def _all_structs(v: str) -> E:
    return E(f"coalesce(list_bool_and(list_transform(json_extract({v}, '$[*]'), "
             f"__e -> json_type(__e) IN ('OBJECT', 'NULL'))), TRUE)")


def _json_struct_list(v: str) -> E:
    empty = "CAST([] AS JSON[])"
    return E(
        f"(CASE WHEN {v} IS NULL OR {trim(v)} = '' THEN {empty} "
        f"WHEN NOT json_valid({v}) THEN {empty} "
        f"WHEN json_type({v}) = 'OBJECT' THEN [CAST({v} AS JSON)] "
        f"WHEN json_type({v}) = 'ARRAY' AND {_all_structs(v)} THEN json_extract({v}, '$[*]') "
        f"ELSE {empty} END)")


def _json_field(e: str, key: str) -> E:
    """A StringType struct field: strings unquoted, other JSON values as compact JSON text."""
    path = lit("$." + key)
    return E(f"(CASE json_type({e}, {path}) WHEN 'VARCHAR' THEN json_extract_string({e}, {path}) "
             f"WHEN 'NULL' THEN NULL ELSE CAST(json_extract({e}, {path}) AS VARCHAR) END)")


# ---------------------------------------------------------------------------
# The processor.
# ---------------------------------------------------------------------------
def curate(con: duckdb.DuckDBPyConnection,
           interactions: Source,
           licensed: Source = None,
           agents: Source = None,
           *,
           exclude_agent_identities: bool = True,
           agent_identity_patterns=DEFAULT_AGENT_IDENTITY_PATTERNS,
           include_raw_passthrough: bool = False,
           drop_exclude_reasons: Iterable[str] = DEFAULT_DROP_EXCLUDE_REASONS,
           agent_type_overrides: Union[Mapping, Iterable, None] = None,
           context: Source = None,
           output: Optional[str] = None) -> duckdb.DuckDBPyRelation:
    """Build the curated table. Sources are table/view names or DuckDB relations.

    The result is materialised as a TEMP table (named `output`, or generated) and
    returned as a relation. Sets the connection's TimeZone to UTC, matching the
    Fabric Spark session, so string timestamps without an offset are read as UTC.

    `drop_exclude_reasons` lists the Exclude_Reason values whose rows are dropped
    (notebook DROP_EXCLUDE_REASONS). `agent_type_overrides` maps an agent id, agent
    name or AppIdentity to an Agent_Type (a mapping or (key, Agent_Type) rows).

    `context` holds already-curated rows that are not being recomputed (the kept
    months of an incremental run). Their AgentId and per-AgentName latest
    CreationDate feed the two history-wide values, the schema-GUID agent link and
    `Agent Last Used Date`, so recomputed rows equal a full rebuild.
    """
    if agent_type_overrides is None:
        overrides = {}
    elif isinstance(agent_type_overrides, Mapping):
        overrides = build_agent_type_overrides(agent_type_overrides.items())
    else:
        overrides = build_agent_type_overrides(agent_type_overrides)
    prefix = "__vl_" + uuid.uuid4().hex[:10]
    con.execute("SET TimeZone = 'UTC'")
    src = _register(con, interactions, prefix + "_src")
    lic_src = _register(con, licensed, prefix + "_lic")
    ag_src = _register(con, agents, prefix + "_ag")
    ctx_src = _register(con, context, prefix + "_ctx")
    out = output or (prefix + "_curated")
    f = Frame(con, src, prefix)
    try:
        _curate(f, lic_src, ag_src, exclude_agent_identities, agent_identity_patterns,
                include_raw_passthrough, list(drop_exclude_reasons or []), overrides, ctx_src)
        con.execute(f"CREATE OR REPLACE TEMP TABLE {q(out)} AS SELECT * FROM {q(f.name)}")
    finally:
        f.cleanup()
        for name in (prefix + "_src", prefix + "_lic", prefix + "_ag", prefix + "_ctx"):
            con.execute(f"DROP VIEW IF EXISTS {q(name)}")
    return con.sql(f"SELECT * FROM {q(out)}")


def _curate(f: Frame, lic_src, ag_src, exclude_agents, agent_patterns, passthrough,
            drop_exclude_reasons, agent_type_overrides, ctx_src=None):
    con = f.con
    ctx_cols = _columns(con, ctx_src) or []

    # 1. RAW FACT (+ optional raw payload copies) ---------------------------------
    if passthrough:
        existing = {c.casefold() for c in f.columns}
        collisions = [c for c in RAW_PASSTHROUGH_COLUMNS.values() if c.casefold() in existing]
        if collisions:
            raise ValueError(f"Raw passthrough output columns already exist: {collisions}")
        for source, target in RAW_PASSTHROUGH_COLUMNS.items():
            f.with_col(target, _as_text(f, source) if f.has(source) else lit(None))

    # 2. OPTIONAL COLUMNS -------------------------------------------------------------
    f.ensure("Message_isPrompt", "TRUE")
    for c in ["ModelTransparencyDetails_ModelProviderName", "ModelTransparencyDetails_ModelName",
              "ApplicationName", "Audit_UserKey", "SensitivityLabelId",
              "AccessedResource_SensitivityLabelId",
              "Id", "RecordId", "Source_RecordKey", "Source_MessageKey", "Source_ResourceKey"]:
        f.ensure(c)
    # Agent-type rule inputs. Parsed tables written before the ingester kept them lack them.
    for c in ["AppIdentity_Text", "Agent_TargetPlatformId", "Agent_TargetName", "Agent_PlatformType"]:
        f.ensure(c)
    if f.has("AppIdentity") and f.type_of("AppIdentity") == "VARCHAR":
        f.with_col("AppIdentity_Text", coalesce(col("AppIdentity_Text"), col("AppIdentity")))
    f.ensure("AppIdentity_AppId")
    if f.has("AppIdentity"):
        if not f.has("AppIdentity_DisplayName"):
            f.with_col("AppIdentity_DisplayName", _as_text(f, "AppIdentity"))
        f.drop("AppIdentity")
    else:
        f.ensure("AppIdentity_DisplayName")

    # Copilot Studio runtime keys and the exclusion flag. Older parsed tables lack them.
    for c in ["AgentId", "AppHost", "Agent_EntraId", "AgentPlatform", "PlatformAgentId",
              "Agent_BotId", "Agent_EnvironmentId"]:
        f.ensure(c)
    f.ensure("Prompts_Available", "TRUE")
    f.with_col("Prompts_Available", coalesce(E(f"upper({trim(s_(col('Prompts_Available')))})"), "TRUE"))
    pid = trim(coalesce(s_(col("PlatformAgentId")), ""))
    aid = trim(coalesce(s_(col("AgentId")), ""))
    pid_platform = E(f"regexp_matches({pid}, {lit(PLATFORM_AGENT_ID_PATTERN)})")
    pid_guid = E(f"regexp_matches({pid}, {lit(BARE_GUID_PATTERN)})")
    f.with_col("Agent_BotId", E(
        f"lower(coalesce({clean('Agent_BotId')}, (CASE WHEN {pid_platform} "
        f"THEN regexp_extract({pid}, {lit(PLATFORM_AGENT_ID_PATTERN)}, 2) "
        f"WHEN {pid_guid} THEN {pid} END)))"))
    f.with_col("Agent_EnvironmentId", E(
        f"coalesce({clean('Agent_EnvironmentId')}, (CASE WHEN {pid_platform} "
        f"THEN regexp_extract({pid}, {lit(PLATFORM_AGENT_ID_PATTERN)}, 1) END))"))
    f.with_col("Agent_EntraId", E(
        f"coalesce({clean('Agent_EntraId')}, (CASE WHEN regexp_matches({aid}, {lit(BARE_GUID_PATTERN)}) "
        f"THEN {aid} END))"))
    # An all-zero GUID (Fabric multi-agent orchestration) is not an agent identity.
    f.with_col("Agent_EntraId", E(
        f"(CASE WHEN regexp_replace(coalesce({col('Agent_EntraId')}, ''), '[-0]', '', 'g') = '' "
        f"THEN CAST(NULL AS VARCHAR) ELSE {col('Agent_EntraId')} END)"))
    # Recomputed here so older parsed rows are classified the same way as new ones.
    f.with_col("Exclude_Reason", E(f"({EXCLUDE_REASON_SQL})"))
    if drop_exclude_reasons:
        f.where(f"NOT coalesce({isin(col('Exclude_Reason'), drop_exclude_reasons)}, FALSE)")

    # 3. ACCESSED RESOURCES: parse + explode_outer ---------------------------------------
    if f.has("AccessedResources"):
        rest = [q(c) for c in f.columns if c != "AccessedResources"]
        lst = _json_struct_list(s_(col("AccessedResources")))
        f.step(f"SELECT {', '.join(rest)}, unnest(CASE WHEN len(__res_list) = 0 "
               f"THEN [CAST(NULL AS JSON)] ELSE __res_list END) AS __res "
               f"FROM (SELECT *, {lst} AS __res_list FROM {q(f.name)})")
        for c, key in [("AccessedResource_Type", "Type"), ("AccessedResource_Action", "Action"),
                       ("AccessedResource_SiteUrl", "SiteUrl")]:
            f.with_col(c, _json_field("__res", key))
        f.drop("__res")
    else:
        for c in ["AccessedResource_Type", "AccessedResource_Action", "AccessedResource_SiteUrl"]:
            f.ensure(c)

    # 4. AI SYSTEM PLUGIN: first element if a list -------------------------------------
    if f.has("AISystemPlugin"):
        v = s_(col("AISystemPlugin"))
        plugin = (f"(CASE WHEN {v} IS NULL OR {trim(v)} = '' THEN NULL "
                  f"WHEN NOT json_valid({v}) THEN NULL "
                  f"WHEN json_type({v}) = 'OBJECT' THEN CAST({v} AS JSON) "
                  f"WHEN json_type({v}) = 'ARRAY' AND json_array_length({v}) > 0 AND {_all_structs(v)} "
                  f"THEN json_extract({v}, '$[0]') ELSE NULL END)")
        f.with_col("__plugin", plugin)
        f.with_col("AISystemPlugin_Id", _json_field("__plugin", "Id"))
        f.with_col("AISystemPlugin_Name", _json_field("__plugin", "Name"))
        f.drop("__plugin")
        f.drop("AISystemPlugin")
    else:
        f.ensure("AISystemPlugin_Id")
        f.ensure("AISystemPlugin_Name")
    f.checkpoint()

    # 5. DATES + RESOURCE COUNT -------------------------------------------------------------
    f.with_col("CreationDate", _creation_ts(f.type_of("CreationDate")))
    f.drop("InteractionDate", "WeekStart", "MonthStart")
    f.with_col("InteractionDate", f"CAST({col('CreationDate')} AS DATE)")
    # Power Query used Day.Monday as the week start (ISO week truncation).
    f.with_col("WeekStart", f"CAST(date_trunc('week', {col('InteractionDate')}) AS DATE)")
    f.with_col("MonthStart", f"CAST(date_trunc('month', {col('InteractionDate')}) AS DATE)")
    if f.has("Resource_Count"):
        f.with_col("Resource_Count", f"CAST({col('Resource_Count')} AS BIGINT)")
    else:
        f.with_col("Resource_Count", "CAST(1 AS BIGINT)")

    # 6. NORMALISED UPN + agent identities -------------------------------------------------------
    lowered_upn = E(f"lower({trim(s_(col('Audit_UserId')))})")
    if f.has("Audit_UserId_Normalized"):
        norm = coalesce(col("Audit_UserId_Normalized"), lowered_upn)
    elif f.has("Audit_UserId"):
        norm = lowered_upn
    else:
        norm = lit(None)
    f.with_col("_NormUPN", norm)
    regex = agent_identity_regex(exclude_agents, agent_patterns)
    if regex:
        f.where(f"NOT coalesce(regexp_matches(lower({col('_NormUPN')}), {lit(regex)}), FALSE)")

    # 7. LICENCE FLAG (deduped dimension -> no fan-out) ----------------------------------------
    lic_cols = _columns(con, lic_src)
    lic_sql = None
    if lic_cols is not None:
        upn_col = first_existing(lic_cols, ["User Principal Name", "userPrincipalName",
                                            "UserPrincipalName", "User principal name",
                                            "User_Principal_Name"])
        has_lic = first_existing(lic_cols, ["Has license", "Has License", "HasLicense", "HasCopilot",
                                            "Has Copilot", "Has Copilot License", "HasCopilotLicense",
                                            "isUser", "Has_license"])
        if "UPN_Normalized" in lic_cols:
            key = col("UPN_Normalized")
        elif upn_col:
            key = E(f"lower({trim(s_(col(upn_col)))})")
        else:
            key = None
        if key is not None:
            hl = s_(col(has_lic)) if has_lic else lit("Unknown")
            lic_sql = (f"SELECT DISTINCT ON (__k) __k AS __lic_key, __h AS {q('Has license')} "
                       f"FROM (SELECT {key} AS __k, {hl} AS __h FROM {lic_src}) "
                       f"WHERE __k IS NOT NULL AND {trim('__k')} <> ''")
    if lic_sql is not None:
        f.left_join(lic_sql, "_NormUPN", "__lic_key", ["Has license"])
    else:
        f.ensure("Has license")

    # 8. AGENT_TITLEID ---------------------------------------------------------------------------
    aid = trim(s_(col("AgentId"))) if f.has("AgentId") else lit(None)
    derived = E(f"(CASE WHEN {aid} IS NULL OR {aid} = '' THEN NULL "
                f"ELSE (CASE WHEN instr({aid}, '.') > 0 THEN split_part({aid}, '.', 1) ELSE {aid} END) END)")
    if f.has("Agent_TitleID"):
        existing = trim(s_(col("Agent_TitleID")))
        f.with_col("Agent_TitleID",
                   f"(CASE WHEN {existing} IS NOT NULL AND {existing} <> '' THEN {existing} ELSE {derived} END)")
    else:
        f.with_col("Agent_TitleID", derived)
    f.ensure("Agent_EntraId")
    f.ensure("AgentName")

    # 9. AGENT LINK (Title ID -> Bot Id -> Entra agent ID -> schema GUID; never by name) ----------
    f.with_col("__lk_title", f"upper({clean('Agent_TitleID')})")
    f.with_col("__lk_bot", f"lower({clean('Agent_BotId')})")
    f.with_col("__lk_entra", f"lower({clean('Agent_EntraId')})")
    f.drop("Agent_LinkID", "Agent_MatchedTitleID", "Agent_LinkMethod")
    f.checkpoint()

    ag_cols = _columns(con, ag_src)
    registry_rows = []
    if ag_cols is not None and "Title ID" in ag_cols:
        def reg(names):
            c = first_existing(ag_cols, names)
            return s_(col(c)) if c else "CAST(NULL AS VARCHAR)"
        cur = con.execute(
            f"SELECT {reg(['Title ID'])} AS title, "
            f"{reg(['Bot Id', 'BotId', 'Bot ID'])} AS bot, "
            f"{reg(['Entra Agent ID', 'Entra agent ID', 'EntraAgentId', 'Entra Agent Id', 'EntraAgentID', 'Agent ID', 'AgentId', 'Agent Id'])} AS entra, "
            f"{reg(['Agent type (A365)', 'Agent Type (A365)', 'Agent type'])} AS type, "
            f"{reg(['Created in', 'Platform'])} AS created_in, "
            f"{reg(['Last updated', 'Last Updated'])} AS updated FROM {ag_src}")
        names = [d[0] for d in cur.description]
        registry_rows = [dict(zip(names, r)) for r in cur.fetchall()]
    maps = build_agent_link_maps(registry_rows)
    schema_sql = (f"SELECT DISTINCT {s_(col('AgentId'))} FROM {q(f.name)} "
                  f"WHERE regexp_matches({s_(col('AgentId'))}, {lit(TITLE_SCHEMA_PATTERN)})")
    if "AgentId" in ctx_cols:
        schema_sql += (f" UNION SELECT DISTINCT {s_(col('AgentId'))} FROM {ctx_src} "
                       f"WHERE regexp_matches({s_(col('AgentId'))}, {lit(TITLE_SCHEMA_PATTERN)})")
    schema_titles = build_schema_title_map(
        r[0] for r in con.execute(schema_sql).fetchall()
    ) if f.has("AgentId") else {}

    links = []
    for r in con.execute(f"SELECT DISTINCT __lk_title, __lk_bot, __lk_entra FROM {q(f.name)}").fetchall():
        schema = schema_titles.get(r[2]) if r[2] and re.match(BARE_GUID_PATTERN, r[2]) else None
        links.append(tuple(r) + tuple(resolve_agent_link(maps, r[0], r[1], r[2], schema)))
    link_table = f.values_table(
        [("_lk_title", "VARCHAR"), ("_lk_bot", "VARCHAR"), ("_lk_entra", "VARCHAR"),
         ("Agent_LinkID", "VARCHAR"), ("Agent_MatchedTitleID", "VARCHAR"), ("Agent_LinkMethod", "VARCHAR")],
        links)
    f.left_join_on(f"SELECT * FROM {q(link_table)}",
                   "__l.__lk_title IS NOT DISTINCT FROM __r._lk_title "
                   "AND __l.__lk_bot IS NOT DISTINCT FROM __r._lk_bot "
                   "AND __l.__lk_entra IS NOT DISTINCT FROM __r._lk_entra",
                   ["Agent_LinkID", "Agent_MatchedTitleID", "Agent_LinkMethod"])
    f.drop("__lk_title", "__lk_bot", "__lk_entra", "_NormUPN")
    if not passthrough:
        f.drop("Audit_UserId_Normalized")

    # 10. MODEL CONTRACT -------------------------------------------------------------------------
    for c in REQUIRED_TEXT_COLS + AGENT_LINK_TEXT_COLS:
        f.ensure(c)
    f.with_col("CreationDate", f"CAST({col('CreationDate')} AS TIMESTAMP)")
    for c in ["InteractionDate", "WeekStart", "MonthStart"]:
        f.with_col(c, f"CAST({col(c)} AS DATE)")
    f.with_col("Resource_Count", f"CAST({col('Resource_Count')} AS BIGINT)")
    f.checkpoint()

    _enrich(f, ag_src, agent_type_overrides, ctx_src, ctx_cols)
    missing = [c for c in ENRICHED_COLS if not f.has(c)]
    assert not missing, f"enrichment incomplete, missing: {missing}"


def _enrich(f: Frame, ag_src, agent_type_overrides, ctx_src=None, ctx_cols=()):
    con = f.con
    appHost, ctxType = low("AppHost"), low("Context_Type")
    resType, resAction = low("AccessedResource_Type"), low("AccessedResource_Action")
    siteUrl, pluginId = low("AccessedResource_SiteUrl"), low("AISystemPlugin_Id")
    isActive = has(resAction, ["send", "draft", "create", "post", "invoke", "write", "patch", "execute"])
    HYPER = "http://schema.skype.com/hyperlink"

    # Environment / License Status
    hl = E(f"upper({trim(coalesce(s_(col('Has license')), ''))})")
    isLic = isin(hl, ["YES", "TRUE", "Y", "1"])
    f.with_col("Environment", when(isLic, "Licensed", "Unlicensed"))
    f.with_col("License Status", when(isLic, "M365 Copilot Licensed", "Unlicensed"))
    actor_env = chain([
        (contains(appHost, "cowork"), "Cowork"),
        (or_(notblank("AgentName"), notblank("AgentId"), isin(appHost, ["autonomous", "logic app"]),
             isin(resType, ["flow", "connector"])), "Agents"),
    ], "User")

    f.with_col("Is_Sensitive", or_(notblank("SensitivityLabelId"), notblank("AccessedResource_SensitivityLabelId")))

    mdl = E(f"upper({coalesce(s_(col('ModelTransparencyDetails_ModelName')), '')})")
    f.with_col("AI_Model", chain([
        (or_(eq(mdl, ""), eq(mdl, "NULL")), "Embedded App (no model logged)"),
        (contains(mdl, "DEEP_LEO"), "GPT-4 (Standard)"),
        (contains(mdl, "REASONING"), "Reasoning Model (o1/o3)"),
        (contains(mdl, "OFFENSIVE"), "Safety Filter (blocked)"),
        (or_(contains(mdl, "GPT-41"), contains(mdl, "GPT-4.1")), "GPT-4.1 (Next Gen)"),
        (or_(contains(mdl, "O3-MINI"), contains(mdl, "O3MINI")), "o3-mini (Reasoning)"),
        (or_(contains(mdl, "O3"), contains(mdl, "O1")), "Reasoning Model (o-series)"),
        (or_(contains(mdl, "GPT-5"), contains(mdl, "GPT5")), "GPT-5 (Next Gen)"),
        (contains(mdl, "CLAUDE"), "Claude (Anthropic)"),
        (contains(mdl, "GEMINI"), "Gemini (Google)"),
        (or_(contains(mdl, "LLAMA"), contains(mdl, "META")), "LLaMA (Meta)"),
        (contains(mdl, "PHI"), "Phi (Microsoft Small Model)"),
    ], mdl))

    # Behavior_Category
    docs, ppts = ["docx", "doc", "rtf"], ["pptx", "ppt", "potx"]
    from_resource = chain([
        (in_lower(resAction, ["sendemailv2", "draftemail", "senddraftemail", "updatedraftemail"]), "Email Drafting"),
        (and_(eq(resType, "emailmessage"), isActive), "Email Drafting"),
        (eq(resType, "emailmessage"), "Email Summarising"),
        (eq(resAction, "mcp_meetingmanagement"), "Meeting Scheduling"),
        (in_lower(resType, ["event", "teamsmeeting"]), "Meeting Prep"),
        (in_lower(resAction, ["postmessagetoconversation", "createchat"]), "Teams Messaging"),
        (in_lower(resType, ["teamsmessage", "teamschat", "teamschannel"]), "Teams Messaging"),
        (eq(resType, "flow"), "Running a Workflow"),
        (and_(in_lower(resType, ["connector", "http"]), isActive), "Running a Workflow"),
        (in_lower(resAction, ["executedatasetquery", "getitems", "getalltables", "gettableviews"]), "Data Querying"),
        (in_lower(resType, ["xlsx", "csv", "xlsm", "xlsb", "xls"]), when(isActive, "Excel Assistance", "Spreadsheet Review")),
        (eq(resType, "peopleinferenceanswer"), "People Lookup"),
        (or_(eq(resType, "listitem"), eq(resType, "aspx")), "Enterprise Searching"),
        (eq(resType, "websearchquery"), "Web Searching"),
        (eq(resType, "pdf"), "PDF Analysis"),
        (and_(in_lower(resType, ["py", "js", "java", "tsx", "jsx", "css", "php", "sh"]), isActive), "Code Writing"),
        (in_lower(resType, ["py", "sql", "js", "java", "json", "xml", "html", "yaml", "yml", "txt"]), "Code Analysis"),
        (and_(in_lower(resType, ["png", "jpg", "jpeg", "svg", "gif"]), isActive), "Image Generation"),
        (in_lower(resType, ["png", "jpg", "jpeg", "gif"]), "Image / Media Analysis"),
        (in_lower(resType, ["streamvideo", "mp4", "mov", "webm", "mkv"]), "Video Summarising"),
        (in_lower(resType, ["planid", "taskids"]), "Task Management"),
        (eq(resType, "looppage"), "Real-time Collaboration"),
        (and_(eq(resType, HYPER), has(siteUrl, ["github.com", "stackoverflow.com", "npmjs.com", "pypi.org",
                                                 "docker.com", "kubernetes.io", "leetcode.com"])), "Code Analysis"),
        (and_(eq(resType, HYPER), has(siteUrl, ["learning.cloud.microsoft", "coursera.org", "udemy.com"])), "Coaching"),
        (and_(eq(resType, HYPER), contains(siteUrl, "sharepoint.com")), "Enterprise Searching"),
        (or_(in_lower(resType, ["external", "http"]), eq(resType, HYPER)), "Web Searching"),
        (and_(in_lower(resType, docs), isActive), "Document Drafting"),
        (and_(in_lower(resType, docs), eq(resAction, "read")), "File Retrieval"),
        (in_lower(resType, docs), "Document Summarising"),
        (and_(in_lower(resType, ppts), isActive), "Presentation Creation"),
        (and_(in_lower(resType, ppts), eq(resAction, "read")), "File Retrieval"),
        (in_lower(resType, ppts), "Presentation Summarising"),
        (has(siteUrl, ["service-now.com", "servicenow.com"]), "IT & Service Desk"),
        (contains(siteUrl, "dynamics.com"), "Sales & Customer"),
    ], None)
    from_plugin = when(eq(pluginId, "enterprisesearch"), "Enterprise Searching", None)
    agentish = or_(notblank("AgentName"), notblank("AgentId"))
    from_context = chain([
        (eq(ctxType, "teamsmeeting"), "Meeting Prep"),
        (eq(ctxType, "streamvideo"), "Video Summarising"),
        (eq(ctxType, "docx"), when(and_(eq(appHost, "word"), isActive), "Document Drafting", "Document Summarising")),
        (in_lower(ctxType, ["xlsx", "xlsm", "xlsb", "xls", "csv"]), "Spreadsheet Review"),
        (in_lower(ctxType, ["pptx", "pptm"]),
         when(and_(eq(appHost, "powerpoint"), isActive), "Presentation Creation", "Presentation Summarising")),
        (in_lower(ctxType, ["teamschat", "teamschannel"]), "Teams Messaging"),
        (eq(ctxType, "aspx"), "Enterprise Searching"),
        (and_(isin(appHost, ["outlook", "outlooksidepane"]), isActive), "Email Drafting"),
        (isin(appHost, ["outlook", "outlooksidepane"]), "Email Summarising"),
        (eq(appHost, "excel"), "Excel Assistance"),
        (and_(eq(appHost, "word"), isActive), "Document Drafting"),
        (eq(appHost, "word"), "Document Summarising"),
        (and_(eq(appHost, "powerpoint"), isActive), "Presentation Creation"),
        (eq(appHost, "powerpoint"), "Presentation Summarising"),
        (eq(appHost, "stream"), "Video Summarising"),
        (eq(appHost, "sharepoint"), "SharePoint Access"),
        (eq(appHost, "designer"), "Image Generation"),
        (eq(appHost, "onenote"), "Note Taking"),
        (eq(appHost, "forms"), "Form / Survey Work"),
        (eq(appHost, "planner"), "Task Management"),
        (in_lower(appHost, ["loop", "whiteboard", "vivaengage"]), "Real-time Collaboration"),
        (eq(appHost, "copilot studio"), "Domain-Specific Agent"),
        (eq(appHost, "autonomous"), "Running a Workflow"),
        (and_(eq(appHost, "logic app"), agentish), "Running a Workflow"),
        (in_lower(appHost, ["datawarehousing core", "power bi"]), "Data Querying"),
    ], "General Chat")
    f.with_col("Behavior_Category", coalesce(from_resource, from_plugin, from_context))

    # Behavior_Enriched
    agentName_l = low("AgentName")
    bcat = col("Behavior_Category")
    f.with_col("Behavior_Enriched", chain([
        (and_(ne(actor_env, "Agents"), ne(actor_env, "Cowork")), bcat),
        (not_(isin(bcat, ["General Q&A", "M365 Chat Q&A", "Teams Q&A", "Browser Q&A", "General Chat"])), bcat),
        (has(agentName_l, ["coach", "mentor", "learning", "career"]), "Coaching"),
        (has(agentName_l, ["research", "analyst", "analy"]), "Research & Analysis"),
        (has(agentName_l, ["sales", "commercial", "customer", "crm", "revenue"]), "Sales & Customer"),
        (has(agentName_l, ["hr", "recruit", "talent", "onboard", "people"]), "HR & People"),
        (has(agentName_l, ["policy", "compliance", "legal", "audit", "risk"]), "Compliance & Policy"),
        (has(agentName_l, ["service", "support", "help", "ticket", "incident"]), "IT & Service Desk"),
        (has(agentName_l, ["summar", "draft", "translat", "editor"]), "Content Generation"),
        (has(agentName_l, ["data", "report", "dashboard", "metric"]), "Data & Reporting"),
        (has(agentName_l, ["knowledge", "faq", "wiki", "buddy", "guide"]), "Knowledge Base"),
        (has(agentName_l, ["idea", "brainstorm", "creative", "design"]), "Ideation & Creative"),
    ], "General Assistance"))

    # Agents 365 lookup (Agent_LinkID -> Title ID) for the *_Full enrichment
    a365 = ["A365_Desc", "A365_Actions", "A365_Code", "A365_Images", "A365_SP", "A365_Type"]
    ag_cols = _columns(con, ag_src)
    tid = first_existing(ag_cols, ["Title ID", "Title Id", "TitleID", "Title ID "]) if ag_cols else None
    if tid:
        def pick(names):
            c = first_existing(ag_cols, names)
            return s_(col(c)) if c else lit(None)
        picks = {
            "A365_Desc": pick(["Agent description", "Agent description ", "Agent Description"]),
            "A365_Actions": pick(["Custom actions", "Custom actions ", "Custom Actions"]),
            "A365_Code": pick(["Can use code interpreter", "Can use code interpreter "]),
            "A365_Images": pick(["Can generate images using user prompt", "Can generate images using user prompt "]),
            "A365_SP": pick(["Can read Sharepoint sites and files", "Can read Sharepoint sites and files "]),
            "A365_Type": pick(["Agent type (A365)", "Agent type (A365) ", "Agent Type (A365)"]),
        }
        sel = ", ".join(f"{v} AS {q(k)}" for k, v in picks.items())
        a365_sql = (f"SELECT DISTINCT ON (__a_title) * FROM (SELECT {trim(s_(col(tid)))} AS __a_title, {sel} "
                    f"FROM {ag_src}) WHERE __a_title IS NOT NULL AND __a_title <> ''")
        f.left_join(a365_sql, "Agent_LinkID", "__a_title", a365)
    for c in a365:
        f.ensure(c)

    # Behavior_Enriched_Full
    be = col("Behavior_Enriched")
    needs = and_(eq(actor_env, "Agents"), eq(be, "General Assistance"))
    desc = when(needs, E(f"lower({coalesce(s_(col('A365_Desc')), '')})"), "")
    actions = when(needs, E(f"lower({coalesce(s_(col('A365_Actions')), '')})"), "")
    search = E(f"concat_ws(' ', {desc}, {actions})")
    resolved = chain([
        (not_(needs), be),
        (has(search, ["coach", "mentor", "learning", "training", "skill"]), "Coaching"),
        (has(search, ["research", "analyst", "analy", "insight", "intelligence"]), "Research & Analysis"),
        (has(search, ["sales", "commercial", "customer", "crm", "pipeline", "prospect", "deal"]), "Sales & Customer"),
        (has(search, ["recruit", "talent", "onboard", "hiring", "employee", "human resource", "job description"]), "HR & People"),
        (has(search, ["policy", "compliance", "legal", "audit", "risk", "governance"]), "Compliance & Policy"),
        (has(search, ["support", "helpdesk", "troubleshoot", "ticket", "incident", "service desk"]), "IT & Service Desk"),
        (has(search, ["summar", "draft", "translat", "content", "communications"]), "Content Generation"),
        (has(search, ["data", "report", "dashboard", "analytics", "metric"]), "Data & Reporting"),
        (has(search, ["knowledge", "faq", "wiki", "guide", "handbook", "documentation"]), "Knowledge Base"),
        (has(search, ["brainstorm", "creative", "design", "innovat"]), "Ideation & Creative"),
        (and_(needs, eq(col("A365_Code"), "Yes")), "Data & Reporting"),
        (and_(needs, eq(col("A365_Images"), "Yes")), "Ideation & Creative"),
        (and_(needs, eq(col("A365_SP"), "Yes")), "Knowledge Base"),
    ], "General Assistance")
    f.with_col("_Resolved", resolved)
    f.checkpoint()
    wfsig = E("lower(concat_ws(' | ', " + ", ".join(
        coalesce(s_(col(c)), "") for c in ["AgentName", "AccessedResource_SiteUrl", "AccessedResource_Action", "AppHost"]) + "))")
    f.with_col("Behavior_Enriched_Full", chain([
        (ne(col("_Resolved"), "Running a Workflow"), col("_Resolved")),
        (has(wfsig, ["servicenow", "salesforce", "dynamics", "workday", "jira", "zendesk", "service desk", "servicedesk"]),
         "Specialist / Line-of-Business Workflow"),
        (has(wfsig, ["outlook", "exchange", "mail"]), "Email Workflow"),
        (has(wfsig, ["calendar", "meeting", "schedul"]), "Meeting Workflow"),
        (has(wfsig, ["power bi", "powerbi", "dataverse", "dataset", "report", "dashboard", "excel", "sql", "analytics"]),
         "Data & Reporting Workflow"),
        (has(wfsig, ["sharepoint", "onedrive", "word", "document", ".doc", "file"]), "Document Workflow"),
        (has(wfsig, ["planner", "task", "approv", "teams", "notify", "post", "list"]), "Coordination Workflow"),
    ], "General Workflow"))
    f.drop("_Resolved")

    # Behavior_Source
    agent_r, plugin_r, app_r = raw("AgentName"), raw("AISystemPlugin_Name"), raw("AppHost")
    src_expr = chain([
        (eq(actor_env, "Cowork"), concat("Cowork", when(ne(agent_r, ""), concat(": ", agent_r), ""))),
        (and_(eq(actor_env, "Agents"), ne(agent_r, "")), concat("Agent: ", agent_r)),
        (ne(plugin_r, ""), concat(app_r, " (", plugin_r, ")")),
        (ne(app_r, ""), app_r),
    ], "Copilot Chat")
    f.with_col("Behavior_Source", concat(bcat, " -> ", src_expr))

    # Value_Outcome
    f.with_col("Value_Outcome", chain([
        (isin(be, ["Email Summarising", "Email Triage", "Email Thread Summary"]), "Time Saved (Email)"),
        (isin(be, ["Meeting Prep", "Video Summarising"]), "Time Saved (Meetings)"),
        (isin(be, ["Document Summarising", "Presentation Summarising", "Note Taking"]), "Time Saved (Documents)"),
        (isin(be, ["Web Searching", "Enterprise Searching", "File Retrieval", "PDF Analysis", "SharePoint Access",
                   "People Lookup", "Knowledge Base"]), "Search Time Saved"),
        (isin(be, ["Teams Messaging", "Meeting Scheduling"]), "Communication Time Saved"),
        (isin(be, ["Spreadsheet Review", "Spreadsheet Analysis", "Excel Assistance"]), "Spreadsheet Time Saved"),
        (isin(be, ["Email Drafting", "Document Drafting", "Presentation Creation", "Image Generation",
                   "Image / Media Analysis", "Image/Media Analysis", "Content Generation", "Ideation & Creative"]),
         "Content Output"),
        (isin(be, ["Real-time Collaboration", "Form / Survey Work"]), "Team Collaboration"),
        (or_(eq(be, "Running a Workflow"), eq(actor_env, "Cowork")), "Workflow Automation"),
        (eq(be, "Task Management"), "Task Coordination"),
        (and_(col("Is_Sensitive"), ne(actor_env, "Agents"), ne(actor_env, "Cowork")), "Compliance & Risk"),
        (isin(be, ["Data Querying", "Data & Reporting", "Research & Analysis"]), "Data-Driven Decisions"),
        (isin(be, ["Code Writing", "Code Analysis", "Code Analysis (URL)"]), "Coding Capability"),
        (isin(be, ["Coaching", "Coaching (URL)"]), "Skills Development"),
        (eq(be, "Sales & Customer"), "Revenue Enablement"),
        (eq(be, "IT & Service Desk"), "Service Desk Deflection"),
        (eq(be, "Compliance & Policy"), "Compliance & Risk"),
        (eq(be, "HR & People"), "HR Expertise"),
        (isin(be, ["Domain-Specific Agent", "Cross-Org Agent"]), "Specialist Expertise"),
    ], "General AI Productivity"))

    # Usage_Mode
    bef = col("Behavior_Enriched_Full")
    a365type = coalesce(s_(col("A365_Type")), "")
    isDelegating = or_(eq(actor_env, "Cowork"), eq(appHost, "autonomous"), contains(bef, "Workflow"),
                       isin(a365type, ["Autonomous", "Workflow", "Triggered"]))
    producing = ["Email Drafting", "Document Drafting", "Presentation Creation", "Image Generation", "Code Writing",
                 "Code Analysis", "Code Analysis (URL)", "Data Querying", "Spreadsheet Analysis", "Excel Assistance",
                 "Content Generation", "Ideation & Creative", "Research & Analysis", "Data & Reporting",
                 "Sales & Customer", "HR & People", "IT & Service Desk", "Compliance & Policy", "Coaching",
                 "Coaching (URL)", "Domain-Specific Agent", "Cross-Org Agent", "Form / Survey Work",
                 "Real-time Collaboration", "Note Taking", "Teams Messaging", "Meeting Scheduling", "Task Management"]
    consuming = ["Document Summarising", "Email Summarising", "Email Thread Summary", "Email Triage",
                 "Presentation Summarising", "Video Summarising", "Meeting Prep", "Image / Media Analysis",
                 "Image/Media Analysis", "Sensitive Content Interaction"]
    finding = ["Web Searching", "Enterprise Searching", "PDF Analysis", "SharePoint Access", "File Retrieval",
               "People Lookup", "Knowledge Base", "Spreadsheet Review"]
    f.with_col("Usage_Mode", chain([
        (isDelegating, "5 - Delegating"),
        (isin(bef, producing), "4 - Producing"),
        (isin(bef, consuming), "3 - Consuming"),
        (isin(bef, finding), "2 - Finding"),
    ], "1 - Asking"))

    # Expertise_Role
    f.with_col("Expertise_Role", chain([
        (isin(bef, ["Data Querying", "Data & Reporting", "Spreadsheet Analysis"]), "Data Analyst"),
        (isin(bef, ["Code Writing", "Code Analysis", "Code Analysis (URL)"]), "Software Engineer"),
        (isin(bef, ["Research & Analysis"]), "Business Analyst"),
        (isin(bef, ["Compliance & Policy", "Sensitive Content Interaction"]), "Compliance Specialist"),
        (isin(bef, ["Sales & Customer"]), "Sales Consultant"),
        (isin(bef, ["IT & Service Desk"]), "IT Specialist"),
        (isin(bef, ["HR & People"]), "HR Specialist"),
        (isin(bef, ["Coaching", "Coaching (URL)"]), "Coach"),
        (or_(contains(bef, "Workflow"), eq(bef, "Task Management")), "Automation Engineer"),
        (isin(bef, ["Domain-Specific Agent", "Cross-Org Agent"]), "Domain Expert"),
        (isin(bef, ["Email Drafting"]), "Communications Specialist"),
        (isin(bef, ["Email Triage", "Meeting Scheduling", "Email Summarising", "Email Thread Summary"]), "Executive Assistant"),
        (isin(bef, ["Document Drafting", "Content Generation", "Note Taking", "Document Summarising"]), "Content Writer"),
        (isin(bef, ["Presentation Creation", "Presentation Summarising"]), "Presentation Designer"),
        (isin(bef, ["Image Generation", "Image/Media Analysis", "Image / Media Analysis", "Ideation & Creative"]), "Visual Designer"),
        (isin(bef, ["Meeting Prep", "Video Summarising"]), "Meeting Coordinator"),
        (isin(bef, ["Web Searching", "PDF Analysis", "Knowledge Base"]), "Researcher"),
        (isin(bef, ["Enterprise Searching", "SharePoint Access", "File Retrieval", "People Lookup"]), "Knowledge Navigator"),
        (isin(bef, ["Spreadsheet Review", "Excel Assistance"]), "Spreadsheet Specialist"),
        (isin(bef, ["Real-time Collaboration", "Form / Survey Work", "Form/Survey Work", "Teams Messaging"]), "Collaboration Lead"),
    ], None))

    # Efficiency_Breakdown
    f.with_col("Efficiency_Breakdown", chain([
        (isin(bef, ["Email Summarising", "Email Triage", "Email Thread Summary", "Email Drafting"]), "Email"),
        (isin(bef, ["Document Summarising", "Note Taking", "Document Drafting", "Content Generation"]), "Document Assistance"),
        (isin(bef, ["Presentation Summarising", "Presentation Creation"]), "Presentations"),
        (isin(bef, ["Meeting Prep", "Video Summarising", "Meeting Scheduling"]), "Meetings"),
        (isin(bef, ["Web Searching", "Enterprise Searching", "PDF Analysis", "SharePoint Access", "File Retrieval",
                    "People Lookup", "Knowledge Base", "Research & Analysis"]), "Search & Research"),
        (isin(bef, ["Spreadsheet Review", "Excel Assistance", "Spreadsheet Analysis", "Data Querying",
                    "Data & Reporting"]), "Data & Spreadsheets"),
        (isin(bef, ["Image Generation", "Image / Media Analysis", "Image/Media Analysis", "Ideation & Creative",
                    "Code Writing", "Code Analysis", "Code Analysis (URL)"]), "Creative & Technical"),
        (or_(isin(bef, ["Teams Messaging", "Real-time Collaboration", "Form / Survey Work", "Task Management"]),
             contains(bef, "Workflow")), "Collaboration & Workflows"),
        (isin(bef, ["Sales & Customer", "IT & Service Desk", "HR & People", "Compliance & Policy", "Coaching",
                    "Coaching (URL)", "Domain-Specific Agent", "Cross-Org Agent"]), "Specialist Support"),
        (eq(bcat, "Teams Q&A"), "Teams Chat"),
        (eq(bcat, "M365 Chat Q&A"), "BizChat Q&A"),
        (eq(bcat, "Browser Q&A"), "BizChat Q&A"),
    ], "General Q&A"))

    # Web_Grounded_Signal
    isInternal = has(siteUrl, ["sharepoint.com", ".onmicrosoft.com"])
    f.with_col("Web_Grounded_Signal", when(
        or_(eq(resType, "websearchquery"), in_lower(resType, ["external", "http"]),
            and_(eq(resType, HYPER), not_(isInternal))),
        "Web Grounded", "Not Web Grounded"))

    # Behavior_Plausible
    unlic_ok = ["General Chat", "Web Searching", "PDF Analysis", "Document Summarising", "Image / Media Analysis",
                "Image Generation", "Code Analysis", "Translation"]
    plausible_switch = chain([
        (isin(bcat, ["Email Summarising", "Email Drafting"]), "Free Chat Workaround (pasting Email)"),
        (isin(bcat, ["Excel Assistance", "Spreadsheet Review", "Data Querying"]), "Free Chat Workaround (pasting Spreadsheet/Data)"),
        (isin(bcat, ["Meeting Prep", "Meeting Scheduling"]), "Free Chat Workaround (pasting Meeting info)"),
        (eq(bcat, "Teams Messaging"), "Free Chat Workaround (pasting Teams content)"),
        (isin(bcat, ["Enterprise Searching", "People Lookup"]), "Free Chat Workaround (pasting Enterprise data)"),
        (isin(bcat, ["Running a Workflow", "Task Management"]), "Free Chat Workaround (pasting Workflow)"),
        (eq(bcat, "Real-time Collaboration"), "Free Chat Workaround (pasting Loop content)"),
        (eq(bcat, "Code Writing"), "Free Chat Workaround (pasting Code)"),
        (eq(bcat, "Video Summarising"), "Free Chat Workaround (uploading Video)"),
    ], "Free Chat Workaround (Other)")
    f.with_col("Behavior_Plausible", when(
        or_(eq(col("License Status"), "M365 Copilot Licensed"), isin(bcat, unlic_ok)), bcat, plausible_switch))

    # Workflow_Action
    f.with_col("Workflow_Action", when(not_(contains(bef, "Workflow")), "", chain([
        (has(resAction, ["send", "post", "notify"]), "Sending / Notifying"),
        (has(resAction, ["create", "draft", "write", "add"]), "Creating Content"),
        (has(resAction, ["invoke", "execute", "trigger", "run"]), "Invoking / Triggering"),
        (has(resAction, ["update", "patch", "modify", "set"]), "Updating Records"),
        (has(resAction, ["read", "get", "list", "fetch"]), "Reading Data"),
        (has(resAction, ["delete", "remove"]), "Deleting / Removing"),
        (eq(appHost, "autonomous"), "Autonomous Run (no action logged)"),
        (eq(appHost, "logic app"), "Logic App Run (no action logged)"),
    ], "Workflow (other)")))

    # Is_Agent_Activity / Agent Filter
    isAutonomous = or_(isin(appHost, ["autonomous", "logic app"]), isin(resType, ["flow", "connector"]))
    f.with_col("Is_Agent_Activity", or_(notblank("AgentName"), notblank("AgentId"), isAutonomous))
    f.checkpoint()
    agent_act = E(f"({col('Is_Agent_Activity')} = TRUE)")
    f.with_col("Agent Filter", chain([(eq(actor_env, "Cowork"), "Cowork"), (agent_act, "Agents")], None))

    # Grounding Source
    plugin = E(f"lower(concat_ws(' ', {coalesce(s_(col('AISystemPlugin_Id')), '')}, "
               f"{coalesce(s_(col('AISystemPlugin_Name')), '')}))")
    usedWeb = has(plugin, ["bing", "web"])
    usedInternal = or_(f"({col('Resource_Count')} > 0)", notblank("Context_Type"))
    f.with_col("Grounding Source", chain([
        (and_(usedWeb, usedInternal), "Mixed (Internal+Web)"),
        (usedWeb, "External (Web)"),
        (usedInternal, "Internal"),
    ], "Ungrounded"))

    # Agent_Surface / Execution_Trigger
    f.with_col("Agent_Surface", chain([
        (or_(contains(appHost, "cowork"), contains(agentName_l, "cowork")), "Cowork"),
        (contains(agentName_l, "scout"), "Scout"),
        (isAutonomous, "Autonomous / Flow"),
        (agent_act, "Copilot Agents"),
    ], None))

    # Agent type / publisher / consolidated name: classify each distinct key tuple once
    # in Python (describe_agent), then join back.
    at_inputs = [
        ("__at_aid", coalesce(clean("Agent_TargetPlatformId"), clean("AgentId"), clean("PlatformAgentId"))),
        ("__at_name", coalesce(clean("Agent_TargetName"), clean("AgentName"))),
        ("__at_app", clean("AppIdentity_Text")),
        ("__at_type", coalesce(clean("Agent_PlatformType"), clean("AgentPlatform"))),
        ("__at_workload", clean("Workload")),
    ]
    at_keys = [name for name, _ in at_inputs]
    f.drop(*AGENT_TYPE_COLS)
    for name, expr in at_inputs:
        f.with_col(name, coalesce(expr, ""))
    f.checkpoint()
    keys_sql = ", ".join(q(k) for k in at_keys)
    at_rows = [tuple(r) + tuple(describe_agent(*r, overrides=agent_type_overrides))
               for r in f.con.execute(f"SELECT DISTINCT {keys_sql} FROM {q(f.name)}").fetchall()]
    at_table = f.values_table(
        [(k, "VARCHAR") for k in at_keys]
        + [(c, "BOOLEAN" if c == "Agent_Is_Published" else "VARCHAR") for c in AGENT_TYPE_COLS],
        at_rows)
    f.left_join_on(f"SELECT * FROM {q(at_table)}",
                   " AND ".join(f"__l.{q(k)} = __r.{q(k)}" for k in at_keys), AGENT_TYPE_COLS)
    f.drop(*at_keys)

    f.with_col("Execution_Trigger", when(isAutonomous, "Scheduled / Autonomous", "Interactive / On-demand"))

    # UserMonthKey / Delegation_Event_Key / ActivityDate
    user = coalesce(s_(col("Audit_UserId")), "")
    f.with_col("UserMonthKey", concat(user, "|", E(f"strftime({col('MonthStart')}, '%Y-%m')")))
    f.with_col("Delegation_Event_Key", concat(
        user, "|", E(f"strftime({col('InteractionDate')}, '%Y-%m-%d')"), "|",
        coalesce(clean("AgentName"), clean("Workflow_Action"), clean("AppHost"), "unknown-workflow")))
    f.with_col("ActivityDate", f"CAST({col('InteractionDate')} AS TIMESTAMP)")

    # Agent Last Used Date (max CreationDate per raw AgentName; kept months via `context`)
    alu_sql = (f"SELECT {col('AgentName')} AS __alu_name, {col('CreationDate')} AS __alu_cd "
               f"FROM {q(f.name)} WHERE {notblank('AgentName')}")
    if {"AgentName", "CreationDate"} <= set(ctx_cols):
        alu_sql += (f" UNION ALL SELECT {col('AgentName')}, CAST({col('CreationDate')} AS TIMESTAMP) "
                    f"FROM {ctx_src} WHERE {notblank('AgentName')}")
    f.left_join(f"SELECT __alu_name, max(__alu_cd) AS __alu FROM ({alu_sql}) GROUP BY __alu_name",
                "AgentName", "__alu_name", ["__alu"])
    f.with_col("Agent Last Used Date",
               f"(CASE WHEN {notblank('AgentName')} THEN __alu ELSE CAST(NULL AS TIMESTAMP) END)")
    f.drop("__alu")
    f.checkpoint()

    # User_Stage_Maturity / User_Stage (UserMonthMetrics). Like Spark, NULL and ''
    # users share the key "|yyyy-MM" and therefore fan out on the join.
    stage = chain([
        (or_("ActiveDays >= 15", and_("ActiveDays >= 10", "ValueFocusShare >= 0.30", "HasAgent")), "4 - Power"),
        (and_("ActiveDays >= 8", "BehaviorCount >= 5"), "3 - Habitual"),
        (and_("ActiveDays >= 3", "BehaviorCount >= 3"), "2 - Developing"),
    ], "1 - Beginner")
    umkey = concat(coalesce(s_("__u"), ""), "|", E("strftime(__m, '%Y-%m')"))
    umm_sql = (
        f"SELECT {umkey} AS __umkey, {stage} AS {q('UserStage')} FROM ("
        f"SELECT __u, __m, BehaviorCount, ActiveDays, (_HasAgent > 0) AS HasAgent, "
        f"(CASE WHEN _TotalRows > 0 THEN _ValueRows / _TotalRows ELSE 0.0 END) AS ValueFocusShare FROM ("
        f"SELECT {col('Audit_UserId')} AS __u, {col('MonthStart')} AS __m, "
        f"count(DISTINCT {col('Behavior_Enriched_Full')}) AS BehaviorCount, "
        f"max(CASE WHEN {notblank('AgentName')} THEN 1 ELSE 0 END) AS _HasAgent, "
        f"count(DISTINCT {col('InteractionDate')}) AS ActiveDays, "
        f"sum(CASE WHEN {col('Usage_Mode')} IN ('4 - Producing', '5 - Delegating') THEN 1 ELSE 0 END) AS _ValueRows, "
        f"count(*) AS _TotalRows FROM {q(f.name)} GROUP BY {col('Audit_UserId')}, {col('MonthStart')}))")
    f.left_join(umm_sql, "UserMonthKey", "__umkey", ["UserStage"])
    f.rename("UserStage", "User_Stage_Maturity")
    f.with_col("User_Stage", col("User_Stage_Maturity"))
    f.drop(*a365)
