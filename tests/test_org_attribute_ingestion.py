"""Arbitrary org columns survive ingestion, without importing unrelated Graph properties."""
import ast
import json
import sqlite3
from datetime import date
from types import SimpleNamespace

import duckdb
import pytest

import notebook_source
from test_azure_consumption import VIVA_HEADER, table, write_csv
from valuelens_core import org
from valuelens_jobs import publish
from valuelens_jobs.collect import viva
from valuelens_jobs.storage import LocalStore

GRAPH = "Copilot_Org_Data_Direct_Ingester.ipynb"
CREDITS = "credit-consumption/Ingest_Org.ipynb"


def credits():
    ns = notebook_source.namespace(CREDITS, {"PERSON_ALIASES", "CONSUMPTION_FIELDS"})
    ns["ORG_COLUMNS"] = [c for c in ns["PERSON_ALIASES"] if c not in ("person_id", "user_principal_name")]
    ns["EXTRA_COLUMNS"] = {}
    return ns


def graph():
    return notebook_source.namespace(GRAPH, {"select_fields", "MAX_ORG_LEVELS"})


def test_graph_extra_fields_match_fabric_and_schema():
    nb = graph()
    assert org.USERS_URL.split("$select=", 1)[1].split("&")[0] == nb["select_fields"]
    user = {
        "userPrincipalName": "person@example.invalid", "department": "Operations",
        "employeeType": "Permanent", "employeeHireDate": "2024-01-02T00:00:00Z",
        "userType": "Member", "usageLocation": "GB", "state": "North",
        "employeeOrgData": {"costCenter": "010", "division": "Services"},
        "onPremisesExtensionAttributes": {f"extensionAttribute{i}": str(i) for i in range(1, 16)},
        "mobilePhone": "must not be ingested", "passwordProfile": {"password": "not ingested"},
        "unselectedProperty": "not ingested",
    }
    expected = org._canonical_org_row(user)
    assert nb["_canonical_org_row"](user) == expected
    columns, rows = org.build_snapshot([user])
    snapshot = dict(zip(columns, rows[0]))
    assert {c: snapshot[c] for c in expected} == expected
    assert snapshot["costCenter"] == "010" and snapshot["extensionAttribute15"] == "15"
    assert not ({"mobilePhone", "passwordProfile", "unselectedProperty"} & set(columns))

    # Evaluate the actual Spark schema expression without requiring a local Spark runtime.
    cells = json.loads((notebook_source.NOTEBOOKS / GRAPH).read_text(encoding="utf-8"))["cells"]
    tree = ast.parse("".join(cells[12]["source"]))
    assignment = next(n for n in tree.body if isinstance(n, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id == "schema" for t in n.targets))
    ns = {"StructType": list, "StructField": lambda name, dtype, nullable: (name, dtype),
          "StringType": lambda: "string"}
    exec(compile(ast.Module(body=[assignment], type_ignores=[]), GRAPH, "exec"), ns)
    assert ns["schema"] == [(c, "string") for c in org.BASE_COLUMNS]


@pytest.mark.parametrize("payload", [{}, {"employeeOrgData": None}, {"onPremisesExtensionAttributes": None}])
def test_graph_absent_optional_fields_are_nullable(payload):
    user = {"userPrincipalName": "person@example.invalid", **payload}
    row = org._canonical_org_row(user)
    assert row == graph()["_canonical_org_row"](user)
    assert row["costCenter"] is None and row["extensionAttribute15"] is None


@pytest.mark.parametrize("payload", [
    {"employeeOrgData": []}, {"onPremisesExtensionAttributes": "invalid"},
    {"employeeOrgData": {"division": {"unexpected": "object"}}},
    {"employeeType": ["not", "scalar"]},
])
def test_graph_rejects_malformed_org_attributes(payload):
    user = {"userPrincipalName": "person@example.invalid", **payload}
    for build in (org.build_snapshot, graph()["_canonical_org_row"]):
        with pytest.raises(ValueError):
            build([user] if build is org.build_snapshot else user)


def test_graph_conflicting_extra_attributes_and_empty_snapshots_are_safe():
    first = {"userPrincipalName": "person@example.invalid", "employeeOrgData": {"costCenter": "A"}}
    with pytest.raises(ValueError, match="Conflicting"):
        org.build_snapshot([first, {**first, "employeeOrgData": {"costCenter": "B"}}])
    with pytest.raises(ValueError, match="refusing"):
        org.build_snapshot([], table_exists=True, allow_empty=True)


def test_credit_aliases_safe_names_and_strings_match_azure():
    nb = credits()
    assert nb["PERSON_ALIASES"] == viva.PERSON_ALIASES
    assert nb["CONSUMPTION_FIELDS"] == viva.CONSUMPTION_FIELDS
    headers = ["Email", "Department", "CostCentre", "Region ID", "3rd Cohort", "Sparse.Flag", "Cohort Date",
               "MetricDate", "_loaded_at", "credits_used"]
    expected = {"Region ID": "Region_ID", "3rd Cohort": "attribute_3rd_Cohort", "Sparse.Flag": "Sparse_Flag",
                "Cohort Date": "Cohort_Date"}
    for planner in (org.org_extra_columns, nb["org_extra_columns"]):
        assert planner(headers, viva.PERSON_ALIASES, viva.CONSUMPTION_FIELDS) == expected
    nb["EXTRA_COLUMNS"] = expected
    person = nb["normalise_person"]({"Email": " PERSON@example.invalid ", "CostCentre": "001",
                                     "Region ID": 42, "3rd Cohort": True, "Sparse.Flag": None,
                                     "Cohort Date": date(2024, 1, 2)})
    assert person["person_id"] == "person@example.invalid"
    assert (person["cost_center"], person["Region_ID"], person["attribute_3rd_Cohort"]) == ("001", "42", "True")
    assert person["Sparse_Flag"] is None
    assert person["Cohort_Date"] == "2024-01-02"


@pytest.mark.parametrize("headers", [
    ["Team.Code", "Team Code"], ["Cohort", "cohort"], ["___"], ["a" * 129],
    ["_loaded.at"], ["a`b", "a_b"],
])
def test_custom_column_collisions_and_invalid_names_fail_before_writing(headers):
    nb = credits()
    for planner in (org.org_extra_columns, nb["org_extra_columns"]):
        with pytest.raises(ValueError):
            planner(headers, viva.PERSON_ALIASES)


def test_custom_column_cannot_shadow_a_consumption_fact():
    for planner in (org.org_extra_columns, credits()["org_extra_columns"]):
        with pytest.raises(ValueError, match="collide"):
            planner(["service.id"], viva.PERSON_ALIASES, viva.CONSUMPTION_FIELDS)


def test_credit_custom_fields_keep_source_precedence_and_latest_populated_value():
    nb = credits()
    nb["EXTRA_COLUMNS"] = {"Team.Code": "Team_Code", "Sparse": "Sparse"}
    nb["ORG_COLUMNS"] += ["Sparse", "Team_Code", "Absent"]
    candidates = [
        {"UPN": "person@example.invalid", "MetricDate": "2026-01-01", "Team.Code": "A", "Sparse": "present"},
        {"UPN": "person@example.invalid", "MetricDate": "2026-02-01", "Team.Code": "B"},
        {"UPN": "person@example.invalid", "MetricDate": "2026-03-01", "Team.Code": " "},
    ]
    key, values = nb["org_candidate"](candidates[0], 0)
    for row in candidates[1:]:
        values = nb["merge_attributes"](values, nb["org_candidate"](row, 0)[1])
    automatic = dict(zip(["person_id", "user_principal_name"] + nb["ORG_COLUMNS"], nb["org_record"]((key, values))))
    assert (automatic["Team_Code"], automatic["Sparse"], automatic["Absent"]) == ("B", "present", None)
    _, manual = nb["org_candidate"]({"Email": " PERSON@example.invalid ", "Team.Code": "Manual", "Sparse": ""}, 1)
    for left, right in ((values, manual), (manual, values)):
        merged = nb["merge_attributes"](left, right)
        row = dict(zip(["person_id", "user_principal_name"] + nb["ORG_COLUMNS"], nb["org_record"]((key, merged))))
        assert (row["Team_Code"], row["Sparse"]) == ("Manual", "present")


def test_fabric_schema_plan_keeps_absent_columns_and_is_idempotent():
    ns = credits()
    existing = ["person_id", "user_principal_name", "Old_Field", "_loaded_at"]
    ns.update({
        "TBL": "org_attributes",
        "sources": [(SimpleNamespace(columns=["UPN", "Team.Code"]), 1)],
        "spark": SimpleNamespace(catalog=SimpleNamespace(tableExists=lambda name: True),
                                 table=lambda name: SimpleNamespace(columns=existing)),
    })
    cells = json.loads((notebook_source.NOTEBOOKS / CREDITS).read_text(encoding="utf-8"))["cells"]
    plan = ast.parse("".join(cells[3]["source"])).body[:4]
    code = compile(ast.Module(body=plan, type_ignores=[]), CREDITS, "exec")
    exec(code, ns)
    assert ns["ORG_COLUMNS"][-2:] == ["Old_Field", "Team_Code"]
    columns = list(ns["ORG_COLUMNS"])
    exec(code, ns)
    assert ns["ORG_COLUMNS"] == columns
    ns["sources"] = []
    exec(code, ns)
    assert ns["ORG_COLUMNS"] == columns


def test_azure_custom_org_fields_survive_reloads_and_publication(tmp_path):
    store = LocalStore(tmp_path / "store")
    drop = tmp_path / "drop"
    name = "PersonServiceCreditsMetrics.csv"
    base = ["opaque-person", "person@example.invalid", "service", "service", "policy", "2026-01-01",
            1, 10, 2, 10, "Operations"]
    assert len(base) == len(VIVA_HEADER)
    path = write_csv(drop, name, VIVA_HEADER + ["Team.Code", "Region ID", "Sparse"],
                     [base + ["A", 42, "present"]])
    viva.ingest(store, {name: path})
    initial = table(store, viva.TBL_METRICS)[0]
    assert (initial["Team_Code"], initial["Region_ID"], initial["Sparse"]) == ("A", "42", "present")
    assert initial["credits_used"] == 2.0  # facts keep their numeric type
    nb = credits()
    nb["EXTRA_COLUMNS"] = nb["org_extra_columns"](
        VIVA_HEADER + ["Team.Code", "Region ID", "Sparse"], viva.PERSON_ALIASES, viva.CONSUMPTION_FIELDS)
    fabric_person = nb["normalise_person"](dict(zip(
        VIVA_HEADER + ["Team.Code", "Region ID", "Sparse"], base + ["A", 42, "present"])))
    assert {c: initial[c] for c in fabric_person} == fabric_person

    # Blank or removed attributes don't erase previously populated values; new fields evolve schema.
    path = write_csv(drop, name, VIVA_HEADER + ["Team.Code", "New flag"], [base + [" ", "True"]])
    viva.ingest(store, {name: path})
    row = table(store, viva.TBL_METRICS)[0]
    assert (row["Team_Code"], row["Region_ID"], row["Sparse"], row["New_flag"]) == ("A", "42", "present", "True")
    assert not any(c in row for c in ("MetricDate", "__source_file", "Team.Code"))
    assert viva.ORG_COLUMNS == [c for c in viva.PERSON_ALIASES if c not in ("person_id", "user_principal_name")]
    before_empty = store.path(f"curated/{viva.TBL_METRICS}/part-0.parquet").read_bytes()
    path = write_csv(drop, name, VIVA_HEADER, [])
    assert viva.ingest(store, {name: path})["metric_rows"] == 0
    assert store.path(f"curated/{viva.TBL_METRICS}/part-0.parquet").read_bytes() == before_empty

    # Publication already adds all Parquet columns; verify the new attributes make it to SQL.
    conn = sqlite3.connect(":memory:")
    try:
        publish.publish(conn, store, [viva.TBL_METRICS])
        assert conn.execute('SELECT Team_Code, Region_ID, New_flag FROM viva_credits_weekly').fetchone() == (
            "A", "42", "True")
    finally:
        conn.close()
    con = duckdb.connect()
    try:
        schema = con.execute("DESCRIBE SELECT * FROM read_parquet(?)",
                             [str(store.path(f"curated/{viva.TBL_METRICS}/part-0.parquet"))]).fetchall()
        assert {dtype for column, dtype, *_ in schema if column in ("Team_Code", "Region_ID", "New_flag")} == {"VARCHAR"}
    finally:
        con.close()


def test_azure_colliding_custom_headers_preserve_last_good_file(tmp_path):
    store = LocalStore(tmp_path / "store")
    name = "PersonServiceCreditsMetrics.csv"
    base = ["opaque", "person@example.invalid", "service", "service", "policy", "2026-01-01",
            1, 10, 2, 10, "Operations"]
    path = write_csv(tmp_path / "drop", name, VIVA_HEADER + ["Team.Code"], [base + ["A"]])
    viva.ingest(store, {name: path})
    before = store.path(f"curated/{viva.TBL_METRICS}/part-0.parquet").read_bytes()
    path = write_csv(tmp_path / "drop", name, VIVA_HEADER + ["Team.Code", "Team Code"], [base + ["A", "B"]])
    with pytest.raises(ValueError, match="collide"):
        viva.ingest(store, {name: path})
    assert store.path(f"curated/{viva.TBL_METRICS}/part-0.parquet").read_bytes() == before
