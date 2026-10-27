"""Workday org data on Azure (data source `workday`).

`valuelens_core.workday` is checked against the Fabric notebook Copilot_Org_Data_Workday_Lander (its
settings, name rules and messages) and against the Fabric regression's fixtures and expectations
(tests/fabric_workday_enrichment.py). Then the CSV reader, the drop folder collector (storage and
SharePoint), the job wiring, the deployment settings and the publish into Azure SQL.
"""
from __future__ import annotations

import ast
import json
import os
import re
import sqlite3
from pathlib import Path

import duckdb
import pytest

from fabric_workday_enrichment import SOURCE
from test_azure_consumption import G, Resp, _sharepoint_handler, make_api
from test_workday_enrichment import namespace as notebook
from valuelens_core import org, workday
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import publish as pub
from valuelens_jobs.collect import workday as collector
from valuelens_jobs.collect.graph import _replace_snapshot
from valuelens_jobs.config import Settings
from valuelens_jobs.storage import LocalStore

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = SOURCE.parent / "samples" / "org_workday" / "workday_org_sample.csv"
SITE = "contoso.sharepoint.com,1111,2222"
BASE = "raw/copilot_org_data/part-0.parquet"
PREVIEW = "raw/copilot_org_data_workday_preview/part-0.parquet"
MODULES = frozenset({"core", "orgData", "workday"})
# The notebook's defaults: an enriched copy to review.
DEFAULT = Settings(modules=MODULES)
# What the installer deploys, as the Fabric installer sets the notebook: the org data itself.
IN_PLACE = Settings(modules=MODULES, workday_output_table="dbo.copilot_org_data", workday_allow_base_overwrite=True)

# The notebook's setting -> the Config field.
FIELDS = {"MODE": "mode", "BASE_TABLE": "base_table", "OUTPUT_TABLE": "output_table",
          "WORKDAY_EMAIL_COLUMN": "email_column", "INCLUDE_UNMATCHED_WORKDAY": "include_unmatched",
          "MIN_WORKDAY_MATCH_RATE": "min_match_rate", "ALLOW_BASE_OVERWRITE": "allow_base_overwrite"}

# The Fabric regression's fixtures, as Azure stores the org data: every value a string.
ORACLE_BASE_COLUMNS = ["PersonId", "id", "JobTitle", "Organization", "managerUPN", "DirectReports",
                       "accountEnabled", "OrgData_Source"]
ORACLE_BASE = [
    ["alice@example.com", "id-a", None, "", "boss@example.com", "2", "true", "old-a"],
    ["bob@example.com", "id-b", "Entra role", "Entra dept", None, "0", "false", "old-b"],
    ["carol@example.com", "id-c", "Keep role", "Keep dept", None, "1", "true", "old-c"],
]
ORACLE_COLUMNS = ["primaryWorkEmail", "Persona", "Job_Profile", "Job_Family_Group", "CustomAttribute", "jobtitle"]
ORACLE_WORKERS = [
    [" ALICE@example.com ", "Advisor", "Workday role", "WD dept", "alpha", "secretariat"],
    ["bob@example.com", "Engineer", "Another role", "WD dept", "beta", "operations"],
    ["dave@example.com", "Analyst", "New role", "WD dept", "gamma", "finance"],
]
CFG = workday.Config()

# Entra ID users for four of the sample's five workers, and one person the export doesn't have.
USERS = [
    {"userPrincipalName": "Avery.Diaz@contoso.com", "displayName": "Avery Diaz", "department": "Operations",
     "jobTitle": "Analyst", "country": "GB", "accountEnabled": True,
     "manager": {"userPrincipalName": "blake.nkemi@contoso.com"}},
    {"userPrincipalName": "blake.nkemi@contoso.com", "displayName": "Blake Nkemi", "accountEnabled": True},
    {"userPrincipalName": "casey.obrien@contoso.com", "displayName": "Casey O'Brien", "department": "Risk"},
    {"userPrincipalName": "dana.whitfield@contoso.com", "displayName": "Dana Whitfield", "accountEnabled": False},
    {"userPrincipalName": "entra.only@contoso.com", "displayName": "Entra Only", "department": "Legal"},
]
SAMPLE_ADDS = ["primaryWorkEmail", "On_Leave", "sub_Country", "Job_Profile", "Job_Family", "Job_Family_Group",
               "Persona", "Compensation_Grade", "Worker_Type", "Worker_SubType"]


def outcome(fn, *args):
    try:
        fn(*args)
    except ValueError as exc:
        return str(exc)
    return None


def enriched(base_columns=ORACLE_BASE_COLUMNS, base=ORACLE_BASE, columns=ORACLE_COLUMNS, rows=ORACLE_WORKERS):
    return workday.enrich(CFG, base_columns, base, columns, rows)


def put(root: Path, name: str, data, stamp=None) -> Path:
    path = root / "landing" / "workday" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    if stamp is not None:
        os.utime(path, (stamp, stamp))
    return path


def table(store, rel):
    rel_ = duckdb.sql(f"SELECT * FROM read_parquet('{store.path(rel).as_posix()}')")
    return rel_.columns, [dict(zip(rel_.columns, r)) for r in rel_.fetchall()]


def entra(store):
    """Write the Entra ID org data as the org collector does; returns it as (columns, rows)."""
    columns, rows = org.build_snapshot(USERS)
    _replace_snapshot(store, "raw/copilot_org_data", columns, rows)
    return table(store, BASE)


# ---------------------------------------------------------------- the notebook's settings and rules
def test_defaults_and_constants_match_the_notebook():
    nb = notebook()
    assert {setting: getattr(CFG, field) for setting, field in FIELDS.items()} == {s: nb[s] for s in FIELDS}
    assert workday.METADATA == nb["_METADATA"]
    text = SOURCE.read_text(encoding="utf-8")
    for message in (workday.NO_EXPORT, workday.ENRICH_SOURCE, workday.STANDALONE_SOURCE):
        assert message in text

    # land_standalone's field lists and aliases, in order (the order decides which alias wins).
    code = ["".join(c["source"]) for c in json.loads(text)["cells"] if c["cell_type"] == "code"]
    [fn] = [n for n in ast.parse(code[1]).body if isinstance(n, ast.FunctionDef) and n.name == "land_standalone"]
    wanted = {"graph_fields", "canonical_fields", "aliases"}
    body = [n for n in fn.body if isinstance(n, (ast.Assign, ast.AugAssign))
            and {t.id for t in (n.targets if isinstance(n, ast.Assign) else [n.target])
                 if isinstance(t, ast.Name)} & wanted]
    scope = {}
    exec(compile(ast.Module(body=body, type_ignores=[]), "land_standalone", "exec"), scope)
    assert workday.GRAPH_FIELDS == scope["graph_fields"]
    assert workday.CANONICAL == scope["canonical_fields"]
    assert list(workday.ALIASES.items()) == list(scope["aliases"].items())


@pytest.mark.parametrize("settings, raises", [
    ({}, False), ({"MODE": "enrich"}, False), ({"MODE": "standalone"}, False),
    ({"MODE": "guess"}, True), ({"MODE": "ENRICH"}, True), ({"INCLUDE_UNMATCHED_WORKDAY": True}, True),
    ({"MIN_WORKDAY_MATCH_RATE": 0}, False), ({"MIN_WORKDAY_MATCH_RATE": 1}, False),
    ({"MIN_WORKDAY_MATCH_RATE": float("nan")}, True), ({"MIN_WORKDAY_MATCH_RATE": float("inf")}, True),
    ({"MIN_WORKDAY_MATCH_RATE": True}, True), ({"MIN_WORKDAY_MATCH_RATE": -0.1}, True),
    ({"MIN_WORKDAY_MATCH_RATE": 1.1}, True), ({"MIN_WORKDAY_MATCH_RATE": "0.5"}, True),
    ({"BASE_TABLE": "dbo.foo;DROP TABLE bar"}, True), ({"OUTPUT_TABLE": "dbo.`x`"}, True),
    ({"OUTPUT_TABLE": "copilot_org_data"}, True), ({"OUTPUT_TABLE": "DBO.COPILOT_ORG_DATA"}, True),
    ({"OUTPUT_TABLE": "dbo.copilot_org_data", "ALLOW_BASE_OVERWRITE": "true"}, True),
    ({"OUTPUT_TABLE": "dbo.copilot_org_data", "ALLOW_BASE_OVERWRITE": True}, False),
    ({"WORKDAY_EMAIL_COLUMN": ""}, True), ({"WORKDAY_EMAIL_COLUMN": " - "}, True),
    ({"WORKDAY_EMAIL_COLUMN": "Work Email"}, False),
], ids=repr)
def test_settings_are_checked_as_the_notebook_checks_them(settings, raises):
    nb = notebook()
    nb.update(settings)
    got = outcome(workday.validate_config, workday.Config(**{FIELDS[k]: v for k, v in settings.items()}))
    assert got == outcome(nb["_validate_config"])
    assert (got is not None) is raises


def test_name_rules_match_the_notebook():
    nb = notebook()
    for name in ("Job Family", "job_family", "Country/Region", "a,b;c{d}e(f)g=h\ti\nj\rk", "  padded  ",
                 "Ünïcode Näme", "PersonId", "Cost Centre #"):
        assert (workday.norm(name), workday.safe_name(name)) == (nb["_norm"](name), nb["_safe_name"](name))
    for names in (["Country", "country"], ["Job Family", "Job_Family"], ["_vlwd_base_key"], ["_wd_join"],
                  ["base join"], ["   "], ["A", "a"], ["PersonId", "JobTitle", "Persona"]):
        for flag in (False, True):
            assert outcome(workday.validate_names, names, flag) == outcome(nb["_validate_names"], names, flag)


# ---------------------------------------------------------------- the Fabric regression's expectations
def test_enrichment_keeps_the_baseline_and_adds_what_it_lacks():
    columns, rows, diagnostics = enriched()
    n = len(ORACLE_BASE_COLUMNS)
    # Every baseline column first and in order, every value unchanged ('' and None included).
    assert columns[:n] == ORACLE_BASE_COLUMNS and [r[:n] for r in rows] == ORACLE_BASE
    assert len(rows) == 3  # no Workday-only person added
    assert {"Persona", "CustomAttribute", "Job_Profile"} <= set(columns)
    assert sum(c.casefold() == "jobtitle" for c in columns) == 1
    got = {r[0]: (r[columns.index("Persona")], r[columns.index("CustomAttribute")]) for r in rows}
    assert got == {"alice@example.com": ("Advisor", "alpha"), "bob@example.com": ("Engineer", "beta"),
                   "carol@example.com": (None, None)}
    # The baseline already has OrgData_Source; the other metadata is added. Raw values aren't trimmed.
    assert columns[n:] == ["primaryWorkEmail", "Persona", "Job_Profile", "Job_Family_Group", "CustomAttribute",
                           "PersonId_Normalized", "TotalEmployees"]
    assert [r[n] for r in rows] == [" ALICE@example.com ", "bob@example.com", None]
    assert [r[-2:] for r in rows] == [["alice@example.com", "3"], ["bob@example.com", "3"], ["carol@example.com", "3"]]
    assert diagnostics == {"base_rows": 3, "workday_rows": 3, "exact_duplicates_collapsed": 0, "matched": 2,
                           "match_rate": 2 / 3, "workday_only_excluded": 1, "output_rows": 3,
                           "added_workday_columns": 5, "skipped_existing_columns": 1}


def test_auto_enriches_when_there_is_a_baseline():
    columns, rows, diagnostics = workday.prepare(CFG, ORACLE_COLUMNS, ORACLE_WORKERS,
                                                 lambda: (ORACLE_BASE_COLUMNS, ORACLE_BASE))
    assert (columns, rows) == enriched()[:2] and diagnostics["mode"] == "enrich"


def test_a_rerun_on_its_own_output_changes_nothing():
    columns, rows, _ = enriched()
    again_columns, again_rows, diagnostics = enriched(columns, rows)
    assert (again_columns, again_rows) == (columns, rows)
    assert (diagnostics["added_workday_columns"], diagnostics["skipped_existing_columns"]) == (0, 6)


def test_exact_duplicate_rows_collapse():
    _, rows, diagnostics = enriched(rows=ORACLE_WORKERS + [list(ORACLE_WORKERS[1])])
    assert rows == enriched()[1] and diagnostics["exact_duplicates_collapsed"] == 1


def test_standalone_lands_every_worker():
    columns, rows, diagnostics = workday.standalone(CFG, ORACLE_COLUMNS, ORACLE_WORKERS)
    people = [dict(zip(columns, r)) for r in rows]
    assert len(people) == 3
    assert {"PersonId", "PersonId_Normalized", "Persona", "CustomAttribute", "managerUPN"} <= set(columns)
    assert all(p["managerUPN"] is None for p in people)  # no invented hierarchy
    emails = {"alice@example.com", "bob@example.com", "dave@example.com"}
    assert {p["PersonId_Normalized"] for p in people} == {p["PersonId"] for p in people} == emails
    assert diagnostics == {"mode": "standalone", "workday_rows": 3, "output_rows": 3,
                           "exact_duplicates_collapsed": 0, "match_rate": None}
    assert workday.standalone(CFG, ORACLE_COLUMNS, ORACLE_WORKERS) == (columns, rows, diagnostics)
    alice = people[0]
    # A header matching a canonical field takes its spelling; aliases fill only what's missing.
    assert "jobtitle" not in columns and alice["JobTitle"] == "secretariat"
    assert (alice["Organization"], alice["Function"], alice["id"]) == ("WD dept", "WD dept", "alice@example.com")
    assert (alice["TotalEmployees"], alice["OrgData_Source"], alice["IsOnLeave"]) == ("3", "workday:standalone", None)
    assert alice["primaryWorkEmail"] == " ALICE@example.com "


def test_standalone_maps_workday_report_headers():
    columns = ["Work Email", "Job Profile", "Worker Type", "On Leave", "Location Country", "Region", "Pay Grade"]
    rows = [["A@x.com", "Analyst", "Employee", " Yes ", "UK", "England", "G5"],
            ["b@x.com", "Lead", "Contractor", "0", None, None, None],
            ["c@x.com", None, None, None, "IE", "Leinster", None]]
    out_columns, out_rows, _ = workday.standalone(workday.Config(email_column="Work Email"), columns, rows)
    assert out_columns[:7] == ["Work_Email", "Job_Profile", "Worker_Type", "On_Leave", "Location_Country",
                               "Region", "Pay_Grade"]
    people = {p["PersonId"]: p for p in (dict(zip(out_columns, r)) for r in out_rows)}
    a = people["a@x.com"]
    assert (a["JobTitle"], a["Compensation_Grade"], a["country"], a["sub_Country"], a["city"]) == (
        "Analyst", "G5", "UK", "England", "England")
    assert [people[k]["IsOnLeave"] for k in ("a@x.com", "b@x.com", "c@x.com")] == ["TRUE", "FALSE", None]


def test_auto_lands_standalone_only_when_there_is_no_baseline():
    assert workday.prepare(CFG, ORACLE_COLUMNS, ORACLE_WORKERS, lambda: None) == workday.standalone(
        CFG, ORACLE_COLUMNS, ORACLE_WORKERS)

    def unreadable():
        raise PermissionError("storage unavailable")

    with pytest.raises(PermissionError):
        workday.prepare(CFG, ORACLE_COLUMNS, ORACLE_WORKERS, unreadable)
    with pytest.raises(ValueError, match="Baseline must have a PersonId column"):
        workday.prepare(CFG, ORACLE_COLUMNS, ORACLE_WORKERS, lambda: (["Other"], [["x"]]))


def test_standalone_never_reads_the_baseline_and_enrich_needs_one():
    def never():
        raise AssertionError("read the baseline")

    assert workday.prepare(workday.Config(mode="standalone"), ORACLE_COLUMNS, ORACLE_WORKERS, never)[2]["mode"] == \
        "standalone"
    with pytest.raises(ValueError, match="Baseline table is missing"):
        workday.prepare(workday.Config(mode="enrich"), ORACLE_COLUMNS, ORACLE_WORKERS, lambda: None)


@pytest.mark.parametrize("mode, columns, rows, message", [
    # The Fabric regression's three rejections.
    ("enrich", ["primaryWorkEmail", "Persona"], [["none@example.com", "P"]],
     "Workday match rate 0.0% is below MIN_WORKDAY_MATCH_RATE."),
    ("standalone", ["primaryWorkEmail", "Persona"], [[None, "P"]], "Workday contains blank work-email keys."),
    ("enrich", ["primaryWorkEmail", "Persona"], [["alice@example.com", "P"], ["ALICE@example.com", "Q"]],
     "Conflicting duplicate Workday email keys; resolve the export upstream."),
    # The notebook's other checks.
    ("enrich", ["primaryWorkEmail"], [["  "]], "Workday contains blank work-email keys."),
    ("enrich", ["primaryWorkEmail"], [], "Workday export parsed 0 rows."),
    ("enrich", ["Email"], [["alice@example.com"]], "Workday must have the configured work-email column."),
    ("standalone", ["Email"], [["alice@example.com"]], "Workday must have the configured work-email column."),
    ("enrich", ["primaryWorkEmail", "TotalEmployees"], [["alice@example.com", "9"]],
     "Workday cannot provide absent system metadata."),
    ("standalone", ["primaryWorkEmail", "OrgData_Source"], [["alice@example.com", "x"]],
     "Workday cannot provide system metadata in standalone mode."),
    ("standalone", ["primaryWorkEmail", "Person Id"], [["alice@example.com", "x"]],
     "Raw PersonId must be exactly named PersonId and explicitly selected as the email key."),
    ("enrich", ["primaryWorkEmail", "Job Family", "job_family"], [["alice@example.com", "x", "y"]],
     "Ambiguous headers after normalization."),
])
def test_rejections(mode, columns, rows, message):
    with pytest.raises(ValueError, match=re.escape(message)):
        workday.prepare(workday.Config(mode=mode), columns, rows, lambda: (ORACLE_BASE_COLUMNS, ORACLE_BASE))


@pytest.mark.parametrize("base_columns, base, message", [
    (["PersonId"], [["alice@example.com"], ["ALICE@example.com "]],
     "Duplicate normalized baseline PersonId keys would cause Graph fanout."),
    (["PersonId"], [["alice@example.com"], [None]], "Baseline contains blank PersonId keys."),
    (["PersonId"], [], "Baseline is empty; refusing empty output."),
    (["PersonId", "personid"], [["a", "a"]], "Ambiguous case-insensitive baseline columns."),
])
def test_baseline_rejections(base_columns, base, message):
    with pytest.raises(ValueError, match=re.escape(message)):
        enriched(base_columns, base)


# ---------------------------------------------------------------- the CSV reader
def test_reads_exports_as_the_notebook_reader_does():
    text = ("\ufeffprimaryWorkEmail, Persona ,Notes\r\n"
            "\r\n"
            'a@x.com,"Multi\nline",""\r\n'
            " b@x.com ,  spaced  ,\r\n")
    assert workday.read_csv([("export.csv", text.encode("utf-8"))]) == (
        ["primaryWorkEmail", "Persona", "Notes"], [["a@x.com", "Multi\nline", None], [" b@x.com ", "  spaced  ", None]])
    a = ("a.csv", b"primaryWorkEmail,Persona\na@x.com,P\n")
    b = ("b.csv", b"primaryWorkEmail,Persona\nb@x.com,Q\n")
    assert workday.read_csv([a, b]) == (["primaryWorkEmail", "Persona"], [["a@x.com", "P"], ["b@x.com", "Q"]])


@pytest.mark.parametrize("files, message", [
    ([], "No CSV paths supplied."),
    ([("e.csv", b"")], "An export file is empty."),
    ([("e.csv", b"\xef\xbb\xbf\r\n\r\n")], "An export file is empty."),
    ([("h.csv", b"primaryWorkEmail,Persona\r\n")], "An export file contains a header but no workers."),
    ([("d.csv", b"Job Family,job_family,primaryWorkEmail\nx,y,a@x.com\n")], "Ambiguous headers after normalization."),
    ([("a.csv", b"primaryWorkEmail,Persona\na@x.com,P\n"), ("b.csv", b"Persona,primaryWorkEmail\nQ,b@x.com\n")],
     "CSV files have different headers or column order; stage one consistent export."),
    ([("w.csv", b"primaryWorkEmail,Persona\na@x.com,P,extra\n")],
     "w.csv: the row ending on line 2 has 3 value(s) and the header has 2."),
    ([("w.csv", b'primaryWorkEmail,Persona\na@x.com,"two\nlines"\nb@x.com\n')],
     "w.csv: the row ending on line 4 has 1 value(s) and the header has 2."),
    ([("l.csv", "primaryWorkEmail,Persona\na@x.com,Zoë\n".encode("latin-1"))],
     "l.csv is not UTF-8 text. Save the Workday report as CSV UTF-8 and upload it again."),
])
def test_reader_rejections(files, message):
    with pytest.raises(ValueError, match=re.escape(message)):
        workday.read_csv(files)


# ---------------------------------------------------------------- the collector
def test_collect_enriches_the_org_data_in_place(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.workday")
    store = LocalStore(tmp_path)
    base_columns, base = entra(store)
    put(tmp_path, "workday_org_sample.csv", SAMPLE.read_bytes())
    out = collector.collect_workday(None, store, IN_PLACE)
    assert out == {"file": "workday_org_sample.csv", "table": "dbo.copilot_org_data", "columns": 45, "mode": "enrich",
                   "base_rows": 5, "workday_rows": 5, "exact_duplicates_collapsed": 0, "matched": 4,
                   "match_rate": 0.8, "workday_only_excluded": 1, "output_rows": 5, "added_workday_columns": 10,
                   "skipped_existing_columns": 1}
    columns, rows = table(store, BASE)
    # Entra ID's people, columns and values are unchanged; its country wins over Workday's.
    assert columns == base_columns + SAMPLE_ADDS + ["OrgData_Source"]
    assert [{c: r[c] for c in base_columns} for r in rows] == base
    people = {r["PersonId"]: r for r in rows}
    assert (people["Avery.Diaz@contoso.com"]["Persona"], people["Avery.Diaz@contoso.com"]["country"]) == (
        "Operations", "GB")
    assert people["casey.obrien@contoso.com"]["On_Leave"] == "1"
    assert all(people["entra.only@contoso.com"][c] is None for c in SAMPLE_ADDS)
    assert {r["OrgData_Source"] for r in rows} == {"entra+workday:additive"}
    assert not store.path(PREVIEW).exists()
    assert "match_rate=80.0%" in caplog.text


def test_collect_writes_a_copy_to_review_by_default(tmp_path):
    store = LocalStore(tmp_path)
    entra(store)
    before = store.path(BASE).read_bytes()
    put(tmp_path, "export.csv", SAMPLE.read_bytes())
    out = collector.collect_workday(None, store, DEFAULT)
    assert (out["table"], out["mode"]) == ("dbo.copilot_org_data_workday_preview", "enrich")
    assert store.path(BASE).read_bytes() == before  # the report's org data is unchanged
    columns, rows = table(store, PREVIEW)
    assert len(rows) == 5 and columns[-len(SAMPLE_ADDS) - 1:] == SAMPLE_ADDS + ["OrgData_Source"]


@pytest.mark.parametrize("settings, rel", [(DEFAULT, PREVIEW), (IN_PLACE, BASE)])
def test_collect_without_entra_org_data_lands_the_export_on_its_own(tmp_path, settings, rel):
    store = LocalStore(tmp_path)
    put(tmp_path, "export.csv", SAMPLE.read_bytes())
    out = collector.collect_workday(None, store, settings)
    assert (out["mode"], out["output_rows"]) == ("standalone", 5)
    _, rows = table(store, rel)
    assert {r["OrgData_Source"] for r in rows} == {"workday:standalone"}
    avery = next(r for r in rows if r["PersonId"] == "avery.diaz@contoso.com")
    assert (avery["Organization"], avery["JobTitle"], avery["IsOnLeave"]) == (
        "Customer", "Customer Service & Operations Analyst (Volume) A4", "FALSE")


def test_enrich_mode_without_entra_org_data_writes_nothing(tmp_path):
    store = LocalStore(tmp_path)
    put(tmp_path, "export.csv", SAMPLE.read_bytes())
    with pytest.raises(ValueError, match="Baseline table is missing"):
        collector.collect_workday(None, store, Settings(modules=MODULES, workday_mode="enrich"))
    assert not store.path(PREVIEW).exists() and not store.path(BASE).exists()


def test_collect_reads_only_the_newest_export(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.workday")
    store = LocalStore(tmp_path)
    old = put(tmp_path, "b-old.csv", "primaryWorkEmail,Persona\nold@x.com,Old\n", 1_000)
    new = put(tmp_path, "a-new.TXT", "primaryWorkEmail,Persona\nnew@x.com,New\n", 2_000)
    note = put(tmp_path, "readme.md", "not an export", 3_000)
    nested = put(tmp_path, "archive/z.csv", "primaryWorkEmail\nnested@x.com\n", 4_000)
    assert collector.collect_workday(None, store, DEFAULT)["file"] == "a-new.TXT"
    assert [r["PersonId"] for r in table(store, PREVIEW)[1]] == ["new@x.com"]
    assert "1 older file(s) ignored" in caplog.text
    assert all(p.exists() for p in (old, new, note, nested))  # the drop folder is never changed


def test_collect_without_an_export_writes_nothing(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.workday")
    store = LocalStore(tmp_path)
    entra(store)
    before = store.path(BASE).read_bytes()
    put(tmp_path, "readme.md", "not an export")
    assert collector.collect_workday(None, store, IN_PLACE) == {"file": None}
    assert store.path(BASE).read_bytes() == before and not store.path(PREVIEW).exists()
    assert workday.NO_EXPORT in caplog.text


@pytest.mark.parametrize("env, message", [
    ({"VALUELENS_WORKDAY_MODE": "guess"}, "VALUELENS_WORKDAY_MODE must be 'auto', 'enrich' or 'standalone'."),
    ({"VALUELENS_WORKDAY_OUTPUT_TABLE": "dbo.copilot_org_data"},
     "Publishing over dbo.copilot_org_data requires deliberate VALUELENS_WORKDAY_ALLOW_BASE_OVERWRITE = True."),
    ({"VALUELENS_WORKDAY_OUTPUT_TABLE": "dbo.people"},
     "VALUELENS_WORKDAY_OUTPUT_TABLE must be dbo.copilot_org_data_workday_preview (the default, to review) or "
     "dbo.copilot_org_data, got 'dbo.people'."),
    ({"VALUELENS_WORKDAY_OUTPUT_TABLE": "people"},
     "Use an unquoted schema.table identifier for dbo.copilot_org_data and VALUELENS_WORKDAY_OUTPUT_TABLE."),
    ({"VALUELENS_WORKDAY_MIN_MATCH_RATE": "most"},
     "VALUELENS_WORKDAY_MIN_MATCH_RATE must be a number from 0 to 1, got 'most'."),
    ({"VALUELENS_WORKDAY_MIN_MATCH_RATE": "1.5"},
     "VALUELENS_WORKDAY_MIN_MATCH_RATE must be finite and between 0 and 1."),
    ({"VALUELENS_WORKDAY_MIN_MATCH_RATE": "nan"},
     "VALUELENS_WORKDAY_MIN_MATCH_RATE must be finite and between 0 and 1."),
    ({"VALUELENS_WORKDAY_MIN_MATCH_RATE": "0.9"},
     "Workday match rate 80.0% is below VALUELENS_WORKDAY_MIN_MATCH_RATE."),
    ({"VALUELENS_WORKDAY_EMAIL_COLUMN": "Work Email"}, "Workday must have the configured work-email column."),
])
def test_bad_settings_fail_naming_the_environment_variable(tmp_path, env, message):
    store = LocalStore(tmp_path)
    entra(store)
    before = store.path(BASE).read_bytes()
    put(tmp_path, "export.csv", SAMPLE.read_bytes())
    settings = Settings.from_env({"VALUELENS_MODULES": "core,orgData,workday", **env})
    with pytest.raises(ValueError, match=re.escape(message)):
        collector.collect_workday(None, store, settings)
    assert store.path(BASE).read_bytes() == before and not store.path(PREVIEW).exists()


def test_headers_too_long_for_a_sql_column_are_dropped(tmp_path, caplog):
    store = LocalStore(tmp_path)
    too_long, longest = "x" * 129, "y" * 128
    put(tmp_path, "export.csv", f"primaryWorkEmail,{too_long},{longest}\na@x.com,1,2\n")
    out = collector.collect_workday(None, store, DEFAULT)
    columns, _ = table(store, PREVIEW)
    assert longest in columns and too_long not in columns and out["columns"] == len(columns)
    assert "longer than 128 characters" in caplog.text


def test_awkward_headers_reach_the_parquet_unchanged(tmp_path):
    store = LocalStore(tmp_path)
    entra(store)
    headers = ["primaryWorkEmail", "Country/Region", "Cost Centre #", "Manager's Name", 'Say "hi"', "Level.1",
               "Ünïcode", "Bracket]"]
    lines = ['"' + h.replace('"', '""') + '"' for h in headers]
    put(tmp_path, "export.csv", ",".join(lines) + "\navery.diaz@contoso.com,UK,CC1,Ann,hi,L1,ü,b\n")
    collector.collect_workday(None, store, IN_PLACE)
    columns, rows = table(store, BASE)
    assert columns[-9:-1] == ["primaryWorkEmail", "Country/Region", "Cost_Centre_#", "Manager's_Name", 'Say_"hi"',
                              "Level.1", "Ünïcode", "Bracket]"]
    avery = next(r for r in rows if r["PersonId"] == "Avery.Diaz@contoso.com")
    assert [avery[c] for c in columns[-8:-1]] == ["UK", "CC1", "Ann", "hi", "L1", "ü", "b"]


def test_collect_reads_the_newest_export_from_sharepoint(tmp_path):
    def stale():
        raise AssertionError("downloaded an older export")

    routes = {
        f"{G}/sites/{SITE}": Resp(200, {"id": SITE}),
        f"{G}/drives/b!drive/root:/ValueLens/workday:/children": Resp(200, {"value": [
            {"name": "workday-old.csv", "id": "o1", "lastModifiedDateTime": "2026-09-01T08:00:00Z"},
            {"name": "workday-new.csv", "id": "n1", "lastModifiedDateTime": "2026-09-30T08:00:00Z"},
            {"name": "readme.md", "id": "t1", "lastModifiedDateTime": "2026-10-01T08:00:00Z"},
            {"name": "archive", "id": "f1", "folder": {}},
        ]}),
        f"{G}/drives/b!drive/items/n1/content": Resp(200, content=b"primaryWorkEmail,Persona\nsp@x.com,From SharePoint\n"),
        f"{G}/drives/b!drive/items/o1/content": stale,
    }
    api, session = make_api(_sharepoint_handler(routes))
    settings = Settings(modules=MODULES, drop_site_id=SITE, drop_drive_id="b!drive", drop_folder="ValueLens")
    store = LocalStore(tmp_path)
    assert collector.collect_workday(api, store, settings)["file"] == "workday-new.csv"
    assert table(store, PREVIEW)[1][0]["Persona"] == "From SharePoint"
    assert not (tmp_path / "landing").exists()
    assert sum(1 for c in session.calls if c[1].endswith("/content")) == 1


def test_after_a_failed_entra_load_the_last_enriched_org_data_stays(tmp_path):
    store = LocalStore(tmp_path)
    entra(store)
    put(tmp_path, "first.csv", SAMPLE.read_bytes(), 1_000)
    collector.collect_workday(None, store, IN_PLACE)
    before = table(store, BASE)
    # The Entra ID load failed, so the baseline is the enriched org data: a newer export changes nothing.
    put(tmp_path, "second.csv", SAMPLE.read_text(encoding="utf-8").replace("Operations", "Changed"), 2_000)
    out = collector.collect_workday(None, store, IN_PLACE)
    assert (out["file"], out["added_workday_columns"]) == ("second.csv", 0)
    assert table(store, BASE) == before
    # The next Entra ID load starts again from Entra ID, so the newer export applies.
    entra(store)
    collector.collect_workday(None, store, IN_PLACE)
    assert "Changed" in {r["Persona"] for r in table(store, BASE)[1]}


# ---------------------------------------------------------------- wiring, deployment and publish
def test_collect_order_and_publish_targets(tmp_path, monkeypatch):
    from valuelens_jobs.collect import audit, graph

    called = []
    for mod, name in ((graph, "collect_licensed"), (audit, "collect_audit"), (graph, "collect_org"),
                      (collector, "collect_workday")):
        monkeypatch.setattr(mod, name, lambda *a, _n=name, **k: called.append(_n))
    store = LocalStore(tmp_path)
    jobs_main.collect(store, DEFAULT, api=object())
    # The audit history runs last, so a slow fetch never keeps the others from running.
    assert called == ["collect_licensed", "collect_org", "collect_workday", "collect_audit"]
    called.clear()
    # It enriches the org data, so it runs only with the orgData module.
    jobs_main.collect(store, Settings(modules=frozenset({"core", "workday"})), api=object())
    assert called == ["collect_licensed", "collect_audit"]

    def org_fails(*a, **k):
        raise RuntimeError("Graph unavailable")

    monkeypatch.setattr(graph, "collect_org", org_fails)
    called.clear()
    out = jobs_main.collect(store, Settings(modules=frozenset({"orgData", "workday"})), api=object())
    assert called == ["collect_workday"] and set(out["errors"]) == {"org"}  # it still runs, on the last org data

    assert jobs_main.publish_targets(DEFAULT) == ["curated", "licensed", "org", "copilot_org_data_workday_preview"]
    assert jobs_main.publish_targets(IN_PLACE) == ["curated", "licensed", "org"]
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core", "workday"}))) == ["curated", "licensed"]
    assert jobs_main.publish_targets(Settings(modules=MODULES, sample_data=True)) == ["curated", "licensed", "org"]
    t = pub.TARGETS["copilot_org_data_workday_preview"]
    assert (t.table, t.prefix, t.partition, t.incremental) == (
        "copilot_org_data_workday_preview", "raw/copilot_org_data_workday_preview", None, False)


def test_settings_from_env():
    s = Settings.from_env({"VALUELENS_MODULES": "core,orgData,workday", "VALUELENS_WORKDAY_MODE": " Enrich ",
                           "VALUELENS_WORKDAY_OUTPUT_TABLE": " dbo.copilot_org_data ",
                           "VALUELENS_WORKDAY_ALLOW_BASE_OVERWRITE": "true",
                           "VALUELENS_WORKDAY_MIN_MATCH_RATE": " 0.8 ", "VALUELENS_WORKDAY_EMAIL_COLUMN": " Work Email "})
    assert s.has("workday")
    assert collector.config(s) == workday.Config(mode="enrich", output_table="dbo.copilot_org_data",
                                                 email_column="Work Email", min_match_rate=0.8,
                                                 allow_base_overwrite=True)
    assert not collector.writes_preview(s)
    empty = Settings.from_env({})
    assert collector.config(empty) == workday.Config() and collector.writes_preview(empty)
    assert not empty.has("workday")


def test_the_deployment_passes_the_installer_settings_to_the_jobs():
    apps = (ROOT / "azure" / "infra" / "modules" / "containerapps.bicep").read_text(encoding="utf-8")
    main = (ROOT / "azure" / "infra" / "main.bicep").read_text(encoding="utf-8")
    assert "{ name: 'VALUELENS_WORKDAY_OUTPUT_TABLE', value: workdayOutputTable }" in apps
    assert ("{ name: 'VALUELENS_WORKDAY_ALLOW_BASE_OVERWRITE', value: workdayAllowBaseOverwrite ? 'true' : 'false' }"
            in apps)
    params = json.loads((ROOT / "installer" / "src" / "azure" / "main.arm.json").read_text(encoding="utf-8"))[
        "parameters"]
    for name, default in (("workdayOutputTable", workday.PREVIEW_TABLE), ("workdayAllowBaseOverwrite", False)):
        assert f"{name}: {name}" in main
        assert params[name]["defaultValue"] == default
    # The defaults are the notebook's; the installer sets the in-place pair, as the Fabric installer does.
    installer = (ROOT / "installer" / "src" / "steps" / "azure" / "index.js").read_text(encoding="utf-8")
    assert "workdayOutputTable: param('dbo.copilot_org_data'), workdayAllowBaseOverwrite: param(true)" in installer


def test_publish_adds_the_workday_columns_to_the_org_table(tmp_path):
    conn = sqlite3.connect(":memory:")
    store = LocalStore(tmp_path)
    entra(store)
    assert pub.publish(conn, store, ["org"])[0]["rows"] == 5
    put(tmp_path, "export.csv", SAMPLE.read_bytes())
    collector.collect_workday(None, store, IN_PLACE)
    assert pub.publish(conn, store, ["org"]) == [
        {"table": "copilot_org_data", "rows": 5, "added_columns": SAMPLE_ADDS + ["OrgData_Source"]}]
    assert conn.execute("SELECT [Organization], [Persona], [Job_Family_Group] FROM copilot_org_data "
                        "WHERE [PersonId] = 'dana.whitfield@contoso.com'").fetchone() == (None, "Engineering",
                                                                                          "Technology")
    # Without Workday the next load has none of its columns: SQL keeps them, empty, and the model ignores them.
    entra(store)
    assert pub.publish(conn, store, ["org"])[0]["added_columns"] == []
    assert conn.execute("SELECT count(*) FROM copilot_org_data WHERE [Persona] IS NOT NULL").fetchone() == (0,)
    # The copy to review is its own table.
    put(tmp_path, "export.csv", SAMPLE.read_bytes())
    collector.collect_workday(None, store, DEFAULT)
    [preview] = pub.publish(conn, store, ["copilot_org_data_workday_preview"])
    assert (preview["table"], preview["rows"]) == ("copilot_org_data_workday_preview", 5)
