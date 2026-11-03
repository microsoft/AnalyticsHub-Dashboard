"""Parity: valuelens_core.{licensed,org,m365} vs the pure-Python logic in the Fabric notebooks."""
from __future__ import annotations

from datetime import date, datetime

import pytest

import notebook_source
from valuelens_core import licensed, m365, org

LICENSED_NB = "Copilot_Licensed_Users_Direct_Ingester.ipynb"
ORG_NB = "Copilot_Org_Data_Direct_Ingester.ipynb"
M365_NB = "Copilot_M365_Activity_Ingester.ipynb"

PRODUCTS = [
    "MICROSOFT 365 E5+MICROSOFT 365 COPILOT",
    "Microsoft 365 E3; Copilot for Microsoft 365",
    "MICROSOFT 365 COPILOT VIRAL TRIAL",
    "Microsoft Copilot Studio",
    "Microsoft 365 Copilot Chat",
    "MICROSOFT 365 E7",
    "MICROSOFT 365 E7 ADD-ON",
    "Security Copilot,M365 Copilot",
    "",
]
CSV = (
    "\ufeffReport Refresh Date,User Principal Name,Display Name,Assigned Products\n"
    "2026-03-01,Ada@contoso.com,Ada,MICROSOFT 365 E5+MICROSOFT 365 COPILOT\n"
    "2026-03-01,bob@contoso.com,Bob,Microsoft 365 E3\n"
    "2026-03-01,Ada@contoso.com ,Ada,MICROSOFT 365 E5+MICROSOFT 365 COPILOT\n"
    ",,,\n"
    "2026-03-01,cy@contoso.com,\"Cy, Jr\",MICROSOFT 365 COPILOT VIRAL TRIAL\n"
)
USERS = [
    {"userPrincipalName": "ceo@contoso.com", "displayName": "Ceo", "accountEnabled": True},
    {"userPrincipalName": "vp@contoso.com", "displayName": "Vp", "department": "Sales",
     "manager": {"userPrincipalName": "ceo@contoso.com"}},
    {"userPrincipalName": "ic@contoso.com", "displayName": None, "accountEnabled": False,
     "manager": {"userPrincipalName": "VP@contoso.com"}},
    {"userPrincipalName": "orphan@contoso.com", "displayName": "Orphan",
     "manager": {"userPrincipalName": "gone@contoso.com"}},
    {"userPrincipalName": "vp@contoso.com", "displayName": "Vp", "department": "Sales",
     "manager": {"userPrincipalName": "ceo@contoso.com"}},
]


@pytest.fixture(scope="module")
def nb_licensed():
    return notebook_source.namespace(LICENSED_NB, {"COPILOT_SKU_PATTERNS", "COPILOT_SKU_EXCLUDE", "_pats", "_excl",
                                                   "COPILOT_PLAN_ID"})


def test_licence_patterns_match_notebook(nb_licensed):
    assert licensed.COPILOT_SKU_PATTERNS == nb_licensed["COPILOT_SKU_PATTERNS"]
    assert licensed.COPILOT_SKU_EXCLUDE == nb_licensed["COPILOT_SKU_EXCLUDE"]


@pytest.mark.parametrize("products", PRODUCTS)
def test_licence_classifier_matches_notebook(nb_licensed, products):
    assert licensed.make_classifier()(products) == nb_licensed["_is_copilot"](products)


def test_licensed_parse_matches_notebook(nb_licensed):
    assert licensed._parse_active_user_report(CSV) == nb_licensed["_parse_active_user_report"](CSV)


def test_licensed_snapshot_shape():
    cols, rows = licensed.build_snapshot(CSV)
    assert cols == ["Assigned_Products", "Display_Name", "Has_license", "Report_Refresh_Date",
                    "User_Principal_Name", "UPN_Normalized"]
    assert [r[-1] for r in rows] == ["ada@contoso.com", "bob@contoso.com", "cy@contoso.com"]
    assert [r[2] for r in rows] == ["TRUE", "FALSE", "FALSE"]


def test_licensed_conflicting_duplicate_rejected():
    bad = CSV.replace("Ada@contoso.com ,Ada,", "Ada@contoso.com ,Ada Lovelace,")
    with pytest.raises(ValueError, match="conflict"):
        licensed.build_snapshot(bad)


def test_licensed_empty_guard():
    header = "User Principal Name,Assigned Products\n"
    with pytest.raises(ValueError):
        licensed.build_snapshot(header)
    with pytest.raises(ValueError):
        licensed.build_snapshot(header, allow_empty=True, table_exists=True)
    assert licensed.build_snapshot(header, allow_empty=True)[1] == []


COPILOT_CSV = (
    "\ufeffReport Refresh Date,User Principal Name,Display Name,Last Activity Date,Report Period\n"
    "2026-03-01,ADA@contoso.com,Ada,2026-02-28,7\n"
    "2026-03-01, bob@contoso.com ,Bob,,7\n"
    ",,,,\n"
    "2026-03-01,ghost@contoso.com,Ghost,,7\n"
)


def test_copilot_report_parse_matches_notebook(nb_licensed):
    users = licensed._parse_copilot_usage_report(COPILOT_CSV)
    assert users == {"ada@contoso.com", "bob@contoso.com", "ghost@contoso.com"}
    assert nb_licensed["_parse_copilot_usage_report"](COPILOT_CSV) == users
    for text in ("", "\ufeff", "Report Refresh Date,User Principal Name\n"):
        assert licensed._parse_copilot_usage_report(text) == set()


def test_copilot_report_parse_rejects_bad_input():
    with pytest.raises(ValueError, match="User Principal Name"):
        licensed._parse_copilot_usage_report("Report Refresh Date,Display Name\n2026-03-01,Ada\n")
    with pytest.raises(ValueError, match="row 2 has 1 columns"):
        licensed._parse_copilot_usage_report("User Principal Name,Display Name\nada@contoso.com\n")


def test_licensed_snapshot_counts_users_in_copilot_report():
    stats = {}
    cols, rows = licensed.build_snapshot(CSV, copilot_users=licensed._parse_copilot_usage_report(COPILOT_CSV),
                                         stats=stats)
    assert [r[2] for r in rows] == ["TRUE", "TRUE", "FALSE"]
    # Ada appears twice in the active-user report (an identical duplicate row).
    assert stats == {"by_product_only": 0, "by_report_only": 1, "by_both": 2, "report_users": 3,
                     "report_not_in_active": 1, "deleted": 0, "live_checked": False, "live_removed": 0,
                     "live_missed": 0}
    assert licensed.build_snapshot(CSV, copilot_users=None) == licensed.build_snapshot(CSV)
    assert licensed.build_snapshot(CSV, copilot_users=set()) == licensed.build_snapshot(CSV)


LIVE_USERS = [
    {"userPrincipalName": "Ada@contoso.com", "assignedPlans": [
        {"servicePlanId": "A62F8878-DE10-42F3-B68F-6149A25CEB97", "capabilityStatus": "Enabled"}]},
    {"userPrincipalName": "bob@contoso.com", "assignedPlans": [
        {"servicePlanId": licensed.COPILOT_PLAN_ID, "capabilityStatus": "Deleted"},
        {"servicePlanId": "00000000-0000-0000-0000-000000000000", "capabilityStatus": "Enabled"}]},
    {"userPrincipalName": "cy@contoso.com", "assignedPlans": [
        {"servicePlanId": licensed.COPILOT_PLAN_ID, "capabilityStatus": "Suspended"}]},
    {"userPrincipalName": "dee@contoso.com", "assignedPlans": [
        {"servicePlanId": licensed.COPILOT_PLAN_ID, "capabilityStatus": "Enabled"}]},
    {"userPrincipalName": None, "assignedPlans": None},
    None,
]


def test_live_licences_match_notebook(nb_licensed):
    known, enabled = licensed.live_copilot_licences(LIVE_USERS)
    assert known == {"ada@contoso.com", "bob@contoso.com", "cy@contoso.com", "dee@contoso.com"}
    assert enabled == {"ada@contoso.com", "dee@contoso.com"}
    assert nb_licensed["live_copilot_licences"](LIVE_USERS) == (known, enabled)
    assert nb_licensed["COPILOT_PLAN_ID"] == licensed.COPILOT_PLAN_ID
    paged = licensed.live_copilot_licences(LIVE_USERS[2:])
    assert licensed.live_copilot_licences(LIVE_USERS[:2], *paged) == (known, enabled)


@pytest.mark.parametrize("live", [None, "real", "concealed"])
def test_licence_checks_match_notebook(nb_licensed, live):
    live = {None: None, "real": licensed.live_copilot_licences(LIVE_USERS),
            "concealed": ({"e58eef6a6bbd3d0293cb306d24a42057"}, set())}[live]

    def rows():
        return [{"UPN": "ada@contoso.com", "Is Deleted": "False", "HasCopilot": "TRUE"},
                {"UPN": "bob@contoso.com", "Is Deleted": "False", "HasCopilot": "TRUE"},
                {"UPN": "gone@contoso.com", "Is Deleted": "True", "HasCopilot": "TRUE"},
                {"UPN": "dee@contoso.com", "Is Deleted": "", "HasCopilot": "FALSE"}]
    core_rows, nb_rows = rows(), rows()
    assert licensed.apply_licence_checks(core_rows, "UPN", live) == \
        nb_licensed["apply_licence_checks"](nb_rows, "UPN", live)
    assert core_rows == nb_rows


def test_licensed_snapshot_unticks_users_without_a_live_plan():
    stats = {}
    live = licensed.live_copilot_licences([{"userPrincipalName": "ada@contoso.com", "assignedPlans": [
        {"servicePlanId": licensed.COPILOT_PLAN_ID, "capabilityStatus": "Enabled"}]},
        {"userPrincipalName": "bob@contoso.com"}, {"userPrincipalName": "cy@contoso.com"}])
    _, rows = licensed.build_snapshot(CSV, copilot_users=licensed._parse_copilot_usage_report(COPILOT_CSV),
                                      stats=stats, live=live)
    assert [r[2] for r in rows] == ["TRUE", "FALSE", "FALSE"]
    assert (stats["live_checked"], stats["live_removed"], stats["live_missed"]) == (True, 1, 0)


def test_org_matches_notebook():
    nb = notebook_source.namespace(ORG_NB, {"MAX_ORG_LEVELS", "HIER_FIXED", "HIER_LEVELS", "HIER_COLUMNS",
                                            "LOW_DEPARTMENT_COVERAGE"})
    nb_rows = nb["_dedupe_org_rows"]([nb["_canonical_org_row"](u) for u in USERS])
    assert nb_rows == org._dedupe_org_rows([org._canonical_org_row(u) for u in USERS])
    assert nb["build_hierarchy"](nb_rows) == org.build_hierarchy(nb_rows)
    assert nb["HIER_COLUMNS"] == org.HIER_COLUMNS
    assert nb["build_hierarchy"](CYCLE_ROWS) == org.build_hierarchy(CYCLE_ROWS)
    assert nb["LOW_DEPARTMENT_COVERAGE"] == org.LOW_DEPARTMENT_COVERAGE
    departments = [r.get("Organization") for r in nb_rows]
    assert nb["department_coverage"](departments) == org.department_coverage(departments)
    for have, total in [(0, 0), (1, 3), (8, 10), (999, 1000)]:
        assert nb["coverage_message"](have, total) == org.coverage_message(have, total)


def test_department_coverage_counts_non_blank_departments_and_advises_when_low():
    assert org.department_coverage(["Sales", "", "  ", None, "HR"]) == (2, 5)
    assert org.department_coverage([]) == (0, 0)
    assert org.coverage_message(1200, 1500) == "1,200 of 1,500 people have a department"
    low = org.coverage_message(2, 5)
    assert low.startswith("2 of 5 people have a department.")
    assert "Department on users in Microsoft Entra ID" in low and "Workday" not in low
    assert org.coverage_message(0, 0) == "0 of 0 people have a department"


def test_org_snapshot_shape():
    cols, rows = org.build_snapshot(USERS)
    by = {r[0]: dict(zip(cols, r)) for r in rows}
    assert len(rows) == 4 and len(cols) == len(org.COLUMNS)
    assert "HierarchyError" in cols
    assert by["ic@contoso.com"]["HierarchyPath"] == "Ceo > Vp > ic@contoso.com"
    assert by["ic@contoso.com"]["OrgLevel"] == "2" and by["vp@contoso.com"]["IsManager"] == "TRUE"
    assert by["orphan@contoso.com"]["Level0_Name"] == "Orphan"
    assert {r["TotalEmployees"] for r in by.values()} == {"4"}
    assert {r["HierarchyError"] for r in by.values()} == {""}
    assert by["ceo@contoso.com"]["accountEnabled"] == "True" and by["vp@contoso.com"]["accountEnabled"] == ""


# A tenant whose manager data contains a cycle: a self-managed CEO at the top, a normal chain
# under them, and a two-person loop (a <-> b) with someone reporting into it.
CYCLE_ROWS = [
    {"PersonId": "ceo@contoso.com", "displayName": "Ceo", "managerUPN": " CEO@contoso.com "},
    {"PersonId": "vp@contoso.com", "displayName": "Vp", "managerUPN": "ceo@contoso.com"},
    {"PersonId": "ic@contoso.com", "displayName": "Ic", "managerUPN": "vp@contoso.com"},
    {"PersonId": "a@contoso.com", "displayName": "A", "managerUPN": "b@contoso.com"},
    {"PersonId": "b@contoso.com", "displayName": "B", "managerUPN": "a@contoso.com"},
    {"PersonId": "c@contoso.com", "displayName": "C", "managerUPN": "a@contoso.com"},
]


def test_org_self_manager_is_root_without_error():
    hier = org.build_hierarchy(CYCLE_ROWS)
    ceo = hier["ceo@contoso.com"]
    assert ceo["HierarchyError"] == ""
    assert ceo["OrgLevel"] == "0" and ceo["HierarchyPath"] == "Ceo"
    assert ceo["TopOfChain_Name"] == "Ceo" and ceo["Level0_Name"] == "Ceo" and ceo["Level1_Name"] == ""
    assert hier["ic@contoso.com"]["HierarchyError"] == ""
    assert hier["ic@contoso.com"]["TopOfChain_Name"] == "Ceo"


def test_org_normal_chain_unchanged():
    hier = org.build_hierarchy(CYCLE_ROWS)
    ic = hier["ic@contoso.com"]
    assert ic["OrgLevel"] == "2" and ic["HierarchyPath"] == "Ceo > Vp > Ic"
    assert [ic[f"Level{i}_Name"] for i in range(4)] == ["Ceo", "Vp", "Ic", ""]
    assert ic["IsManager"] == "FALSE" and ic["DirectReports"] == "0"
    assert hier["vp@contoso.com"]["OrgLevel"] == "1" and hier["vp@contoso.com"]["DirectReports"] == "1"


def test_org_two_person_cycle_kept_and_flagged():
    hier = org.build_hierarchy(CYCLE_ROWS)
    a, b, c = hier["a@contoso.com"], hier["b@contoso.com"], hier["c@contoso.com"]
    assert a["HierarchyError"] == "Cycle detected at 'a@contoso.com'"
    assert a["HierarchyPath"] == "B > A" and a["OrgLevel"] == "1"
    assert b["HierarchyError"] == "Cycle detected at 'b@contoso.com'"
    assert b["HierarchyPath"] == "A > B"
    assert c["HierarchyError"] == "Cycle detected at 'a@contoso.com'"
    assert c["HierarchyPath"] == "B > A > C" and c["OrgLevel"] == "2"


def test_org_path_is_lowercase_upn_chain():
    hier = org.build_hierarchy(CYCLE_ROWS)
    assert hier["ic@contoso.com"]["OrgPath"] == "ceo@contoso.com|vp@contoso.com|ic@contoso.com"
    assert hier["ceo@contoso.com"]["OrgPath"] == "ceo@contoso.com"
    # A cycle truncates the chain the same way HierarchyPath does.
    assert hier["c@contoso.com"]["OrgPath"] == "b@contoso.com|a@contoso.com|c@contoso.com"
    cols, rows = org.build_snapshot(USERS)
    by = {r[0]: dict(zip(cols, r)) for r in rows}
    assert "OrgPath" in cols
    assert by["ic@contoso.com"]["OrgPath"].split("|")[-1] == "ic@contoso.com"
    assert by["orphan@contoso.com"]["OrgPath"] == "orphan@contoso.com"


def test_org_direct_reports_exclude_self():
    hier = org.build_hierarchy(CYCLE_ROWS)
    assert hier["ceo@contoso.com"]["DirectReports"] == "1"
    assert hier["a@contoso.com"]["DirectReports"] == "2" and hier["b@contoso.com"]["DirectReports"] == "1"
    solo = org.build_hierarchy([{"PersonId": "solo@contoso.com", "displayName": "Solo",
                                 "managerUPN": "solo@contoso.com"}])["solo@contoso.com"]
    assert solo["DirectReports"] == "0" and solo["IsManager"] == "FALSE" and solo["HierarchyError"] == ""


def test_org_cycle_snapshot_keeps_rows():
    users = [{"userPrincipalName": "a@x", "manager": {"userPrincipalName": "b@x"}},
             {"userPrincipalName": "b@x", "manager": {"userPrincipalName": "a@x"}}]
    cols, rows = org.build_snapshot(users)
    by = {r[0]: dict(zip(cols, r)) for r in rows}
    assert set(by) == {"a@x", "b@x"}
    assert by["a@x"]["HierarchyError"] == "Cycle detected at 'a@x'"
    assert by["b@x"]["HierarchyError"] == "Cycle detected at 'b@x'"


def test_m365_matches_notebook():
    nb = notebook_source.namespace(M365_NB, {"REPORTS", "COUNTS", "FLAGS", "ACTIVE", "VALUE_COLUMNS",
                                             "_ISO_DURATION", "BY_REPORT", "GRAPH"})
    for name in ("REPORTS", "COUNTS", "FLAGS", "ACTIVE", "VALUE_COLUMNS"):
        assert getattr(m365, name) == nb[name], name
    teams = [{"Report Refresh Date": "2026-03-05", "User Principal Name": "Ada@contoso.com",
              "Team Chat Message Count": "3", "Audio Duration": "PT1H2M3S", "Call Count": ""},
             {"User Principal Name": "", "Call Count": "9"},
             {"User Principal Name": "D41D8CD98F00B204E9800998ECF8427E", "Meeting Count": "1"}]
    apps = [{"User Principal Name": "ada@contoso.com", "Word": "Yes", "Mac": "no", "Report Refresh Date": "2026-03-06"},
            {"User Principal Name": "idle@contoso.com", "Word": "No"}]
    day, loaded_at = date(2026, 3, 4), datetime(2026, 3, 7, 1, 2, 3)
    ours, theirs = {}, {}
    for key, recs in (("teams", teams), ("apps", apps)):
        m365.add_report(ours, key, recs)
        nb["add_report"](theirs, key, recs)
    assert ours == theirs
    assert m365.build_rows(day, ours, loaded_at) == nb["build_rows"](day, theirs, loaded_at)
    assert len(m365.build_rows(day, ours, loaded_at)[0]) == len(m365.COLUMNS)
    today = date(2026, 3, 10)
    loaded = {today.replace(day=d) for d in range(1, 10)}
    assert m365.days_to_load(today, loaded, {date(2026, 3, 2)}, 4) == \
        nb["days_to_load"](today, loaded, {date(2026, 3, 2)}, 4)


def test_m365_report_status_matches_notebook_and_flags_reports_with_no_use():
    nb = notebook_source.namespace(M365_NB, {"REPORTS", "COUNTS", "FLAGS", "ACTIVE", "VALUE_COLUMNS",
                                             "_ISO_DURATION", "BY_REPORT", "GRAPH"})
    reports = {
        "teams": [{"User Principal Name": "a@x", "Call Count": "2"}, {"User Principal Name": "b@x"}],
        "apps": [{"User Principal Name": "a@x", "Word": "No", "Windows": "No"}, {"User Principal Name": "b@x", "Excel": ""}],
        "email": [],
        "sharepoint": None,
        "onedrive": [{"User Principal Name": "a@x", "Synced File Count": "PT0S"}],
    }
    day, at = date(2026, 3, 4), datetime(2026, 3, 5, 6, 0)
    ours = m365.report_status(day, reports, at)
    assert ours == nb["report_status"](day, reports, at)
    by = {r[1]: r[3:6] for r in ours}
    assert by == {"teams": ("ok", 2, 1), "apps": ("no_activity", 2, 0), "email": ("empty", 0, 0),
                  "sharepoint": ("unavailable", 0, 0), "onedrive": ("no_activity", 1, 0),
                  "vivaengage": ("unavailable", 0, 0)}
    assert [r[2] for r in ours] == list(m365.REPORTS.values())
    assert all(len(r) == len(m365.STATUS_SCHEMA) for r in ours)
    assert m365.report_status(day, {"apps": [{"User Principal Name": "a@x", "Mobile": "Yes"}]}, at)[-1][3:6] == ("ok", 1, 1)
