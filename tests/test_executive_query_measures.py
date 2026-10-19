"""The landing page's summary and trend queries work some ValueLens measures out themselves, for speed.

executive-months.dax and executive-summary.dax count active people without the
per-person LEN(TRIM()) test, and the monthly trend works the seat counts out
once rather than once a month. The summary also counts the agents in use
without asking [Active Agent Users] about each agent, and asks for the
organization once rather than once a person. They give the same numbers only
while the measures they reproduce, and the relationships they rely on, stay as
they are here. If a test here fails, review those queries, then update this file.
"""
import importlib.util
import json
import re
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("template_dax", ROOT / "scripts" / "Update-Template-Dax.py")
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)
AUDIT = PATCHER.AUDIT
MONTHS = "app/src/queries/executive/executive-months.dax"
SUMMARY = "app/src/queries/executive/executive-summary.dax"

# Each measure, without comments or layout, and the queries that rely on it.
PINNED = {
    "Usage Rows": (
        (MONTHS, SUMMARY),
        "CALCULATE(COUNTROWS('Chat + Agent Interactions (Audit Logs)'), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is Usage Row] = TRUE()))",
    ),
    "All Active Users": (
        (MONTHS,),
        "IF( ISFILTERED('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "COUNTROWS(FILTER(VALUES('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "LEN(TRIM('Chat + Agent Interactions (Audit Logs)'[Audit_UserId])) > 0 && CALCULATE([Usage Rows]) > 0)), "
        "VAR BlankIds = FILTER( ALL('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "LEN(TRIM('Chat + Agent Interactions (Audit Logs)'[Audit_UserId])) = 0 ) "
        "VAR UsageIds = CALCULATE( DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is Usage Row] = TRUE()) ) "
        "VAR BlankUsageIds = CALCULATE( DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is Usage Row] = TRUE()), KEEPFILTERS(BlankIds) ) "
        "VAR ActiveIds = UsageIds - BlankUsageIds RETURN IF(ActiveIds > 0, ActiveIds) )",
    ),
    "Active Licensed Users": (
        (MONTHS, SUMMARY),
        "IF( ISFILTERED('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "CALCULATE( COUNTROWS(FILTER(VALUES('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "LEN(TRIM('Chat + Agent Interactions (Audit Logs)'[Audit_UserId])) > 0 && CALCULATE([Usage Rows]) > 0)), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[License Status] = \"M365 Copilot Licensed\") ), "
        "VAR BlankIds = FILTER( ALL('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "LEN(TRIM('Chat + Agent Interactions (Audit Logs)'[Audit_UserId])) = 0 ) "
        "VAR UsageIds = CALCULATE( DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is Usage Row] = TRUE()), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[License Status] = \"M365 Copilot Licensed\") ) "
        "VAR BlankUsageIds = CALCULATE( DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is Usage Row] = TRUE()), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[License Status] = \"M365 Copilot Licensed\"), "
        "KEEPFILTERS(BlankIds) ) "
        "VAR ActiveIds = UsageIds - BlankUsageIds RETURN IF(ActiveIds > 0, ActiveIds) )",
    ),
    "% Active Licensed Users": (
        (MONTHS, SUMMARY),
        "VAR _Total = [Licensed Users (Filter-Aware)] VAR _Active = [Active Licensed Users] "
        "RETURN IF(_Total > 0 && _Active <= _Total, DIVIDE(_Active, _Total))",
    ),
    "Inactive Users (Monthly)": (
        (MONTHS,),
        "VAR Activity = SELECTEDVALUE('Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)], \"\") "
        "VAR Licence = SELECTEDVALUE('Chat + Agent Interactions (Audit Logs)'[Environment], \"\") "
        "VAR Measured = NOT (Activity IN {\"Agents\", \"Cowork\"}) && Licence <> \"Unlicensed\" "
        "VAR CalRowsInContext = COUNTROWS('Calendar') "
        "VAR LicensedInScope = CALCULATE( [Total Licensed Users], "
        "TREATAS(VALUES('Chat + Agent Org Data'[PersonId]), 'Copilot Licensed'[UPN_Normalized]) ) "
        "VAR ActiveLicensed = [Active Licensed Users] "
        "RETURN IF( Measured && CalRowsInContext > 0, MAX(LicensedInScope - ActiveLicensed, 0) )",
    ),
    "Licensed Users (Filter-Aware)": (
        (MONTHS,),
        "VAR LicensedUPNs = CALCULATETABLE( VALUES('Copilot Licensed'[UPN_Normalized]), "
        "UPPER(TRIM('Copilot Licensed'[Has license])) IN {\"YES\",\"TRUE\",\"Y\",\"1\"}, "
        "REMOVEFILTERS('Chat + Agent Org Data') ) "
        "RETURN CALCULATE( DISTINCTCOUNT('Chat + Agent Org Data'[PersonId_Normalized]), "
        "TREATAS(LicensedUPNs, 'Chat + Agent Org Data'[PersonId_Normalized]) )",
    ),
    "Total Licensed Users": (
        (MONTHS,),
        "CALCULATE( DISTINCTCOUNT('Copilot Licensed'[UPN_Normalized]), "
        "UPPER(TRIM('Copilot Licensed'[Has license])) IN {\"YES\",\"TRUE\",\"Y\",\"1\"} )",
    ),
    "Active Agent Users": (
        (SUMMARY,),
        "CALCULATE( COUNTROWS(FILTER(VALUES('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]), "
        "LEN(TRIM('Chat + Agent Interactions (Audit Logs)'[Audit_UserId])) > 0 && CALCULATE([AI Tasks]) > 0)), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)] = \"Agents\") )",
    ),
    "AI Tasks": (
        (SUMMARY,),
        "CALCULATE(COUNTROWS('Chat + Agent Interactions (Audit Logs)'), "
        "KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Is Prompt Row] = TRUE()))",
    ),
}

# Strings, quoted names and [names] are kept whole, so a comment marker inside one isn't one.
TOKEN = re.compile(r"\"(?:[^\"]|\"\")*\"|'(?:[^']|'')*'|\[[^\]]*\]|/\*.*?\*/|(?://|--)[^\n]*", re.S)


def code(expression):
    expression = "\n".join(expression) if isinstance(expression, list) else (expression or "")
    kept = TOKEN.sub(lambda m: m.group(0) if m.group(0)[0] in "\"'[" else " ", expression)
    return " ".join(kept.split())


def load(relative):
    with zipfile.ZipFile(ROOT / relative) as archive:
        return json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]


def filtered_by(model, start):
    """The tables a filter on `start` reaches through the model's active relationships."""
    reached, todo = {start}, [start]
    while todo:
        table = todo.pop()
        for r in model.get("relationships", []):
            if r.get("isActive", True) is False:
                continue
            both = r.get("crossFilteringBehavior") == "bothDirections" or r.get("fromCardinality") == "one"
            for source, target, flows in ((r["toTable"], r["fromTable"], True), (r["fromTable"], r["toTable"], both)):
                if flows and source == table and target not in reached:
                    reached.add(target)
                    todo.append(target)
    return reached


class ExecutiveQueryMeasures(unittest.TestCase):
    def test_the_queries_rely_on_these_measures_as_they_are(self):
        self.assertEqual(len(PATCHER.VALUELENS), 2)
        for relative in PATCHER.VALUELENS:
            model = load(relative)
            measures = {m["name"]: m["expression"] for t in model["tables"] for m in t.get("measures", [])}
            for name, (queries, expected) in PINNED.items():
                with self.subTest(template=str(relative), measure=name):
                    self.assertIn(name, measures)
                    self.assertEqual(code(measures[name]), expected, f"[{name}] changed: review {' and '.join(queries)}")

    def test_dates_and_the_audit_log_never_filter_the_seat_or_people_lists(self):
        # So the monthly trend can count seats once for every month, and the summary can ask
        # for the organization once rather than once a person.
        for relative in PATCHER.VALUELENS:
            model = load(relative)
            self.assertIn(AUDIT, filtered_by(model, "Calendar"), relative)
            for start in ("Calendar", AUDIT):
                reached = filtered_by(model, start)
                for table in ("Copilot Licensed", "Chat + Agent Org Data"):
                    with self.subTest(template=str(relative), start=start, table=table):
                        self.assertNotIn(table, reached, f"a filter on {start} now reaches {table}: review {MONTHS} and {SUMMARY}")

    def test_comments_and_layout_are_not_code(self):
        self.assertEqual(code(["A // x", "/* y */ + \"//kept\" -- z", "+ 'T--'[C]"]), "A + \"//kept\" + 'T--'[C]")


if __name__ == "__main__":
    unittest.main()
