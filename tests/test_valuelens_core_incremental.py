"""valuelens_core.curate(context=...): recomputing some months equals a full rebuild.

Two curated values depend on rows outside the month being recomputed: the schema-GUID agent link
(a 'T_<title>.<schema>' agent id seen in any month) and Agent Last Used Date (latest use of the agent
name). `context` carries the kept months' curated rows so an incremental run gets both right.
"""
from __future__ import annotations

import duckdb

from valuelens_core import creation_timestamp_sql, curate

TITLE = "T_11111111-2222-3333-4444-555555555555"
SCHEMA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
COLS = 'Id, AgentId, Agent_LinkID, Agent_MatchedTitleID, Agent_LinkMethod, "Agent Last Used Date", MonthStart'


def _con():
    con = duckdb.connect()
    con.execute(f"""CREATE TABLE src AS SELECT * FROM (VALUES
        ('1', '2026-07-03T10:00:00Z', 'u1@example.invalid', '{TITLE}.{SCHEMA}', 'Agent A'),
        ('2', '2026-08-03T10:00:00Z', 'u2@example.invalid', '{SCHEMA}', 'Agent A'),
        ('3', '2026-07-04T10:00:00Z', 'u2@example.invalid', NULL, 'Agent B'),
        ('4', '2026-09-01T09:00:00Z', 'u3@example.invalid', NULL, 'Agent B'),
        ('5', NULL, 'u3@example.invalid', NULL, 'Agent B'))
        t(Id, CreationDate, Audit_UserId, AgentId, AgentName)""")
    con.execute(f"CREATE TABLE ag AS SELECT '{TITLE}' AS \"Title ID\", 'Agent A' AS Name")
    return con


def _month(con, where):
    ts = creation_timestamp_sql(con, "src")
    return con.sql(f"SELECT * FROM src WHERE coalesce(strftime(CAST({ts} AS DATE), '%Y-%m'), 'none') {where}")


def _rows(rel):
    return sorted(rel.project(COLS).fetchall(), key=lambda r: r[0])


def test_recomputed_month_with_context_equals_full_rebuild():
    con = _con()
    full = {r[0]: r for r in _rows(curate(con, "src", None, "ag", output="full_out"))}
    assert full["2"][4] == "Schema GUID"            # linked only through July's T_<title>.<schema> id

    kept = curate(con, _month(con, "IN ('2026-07', '2026-09')"), None, "ag", output="kept")
    redo = curate(con, _month(con, "IN ('2026-08', 'none')"), None, "ag", context=kept, output="redo")
    assert _rows(redo) == [full["2"], full["5"]]

    redo_july = curate(con, _month(con, "= '2026-07'"), None, "ag",
                       context=con.sql("SELECT * FROM full_out WHERE MonthStart <> DATE '2026-07-01' "
                                       "OR MonthStart IS NULL"), output="redo_july")
    # Agent B's July rows get its September last-used date from the kept month.
    assert _rows(redo_july) == [full["1"], full["3"]]


def test_without_context_the_history_wide_values_are_month_local():
    con = _con()
    alone = {r[0]: r for r in _rows(curate(con, _month(con, "= '2026-08'"), None, "ag", output="alone"))}
    assert alone["2"][4] != "Schema GUID"


def test_creation_timestamp_sql_matches_curated_month():
    con = _con()
    ts = creation_timestamp_sql(con, "src")
    got = con.execute(f"SELECT Id, CAST(date_trunc('month', CAST({ts} AS DATE)) AS DATE) FROM src ORDER BY Id").fetchall()
    curated = curate(con, "src", output="c").project("Id, MonthStart").order("Id").fetchall()
    assert got == curated
    assert creation_timestamp_sql(con, "(SELECT 1 AS Id)") is None
