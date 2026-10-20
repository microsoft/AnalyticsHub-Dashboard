"""Agent 365 dates before 2000 load as blank, in core, in both Fabric notebooks and in the Azure collector."""
import json
import re
from datetime import date, datetime, timezone

import duckdb
import pytest

import notebook_source
from valuelens_core import dates
from valuelens_jobs.collect import agent365

REGISTRY = "Copilot_Agent365_Registry_Ingester.ipynb"
LANDER = "Copilot_Agent365_Lander.ipynb"
CONSTANTS = {"MIN_PLAUSIBLE_YEAR", "YEAR_PATTERN", "DATE_COLUMNS"}

CASES = [
    ("0001-01-01T00:00:00Z", None),
    ("0001-01-01", None),
    ("1/1/0001 12:00:00 AM", None),
    ("1999-12-31T23:59:59Z", None),
    ("2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z"),
    ("2026-09-10T08:00:00Z", "2026-09-10T08:00:00Z"),
    ("9/10/2026 8:00:00 AM", "9/10/2026 8:00:00 AM"),
    ("Not Available", "Not Available"),
    ("", ""),
    (None, None),
    (date(1, 1, 1), None),
    (datetime(2026, 9, 10, tzinfo=timezone.utc), datetime(2026, 9, 10, tzinfo=timezone.utc)),
]


def _cell_sources(notebook):
    cells = json.loads((notebook_source.NOTEBOOKS / notebook).read_text(encoding="utf-8"))["cells"]
    return ["".join(cell["source"]) for cell in cells if cell["cell_type"] == "code"]


@pytest.mark.parametrize(("value", "expected"), CASES)
def test_core_blanks_dates_before_2000(value, expected):
    assert dates.plausible_date(value) == expected


@pytest.mark.parametrize(("value", "expected"), CASES)
def test_registry_ingester_matches_core(value, expected):
    ns = notebook_source.namespace(REGISTRY, CONSTANTS)
    assert ns["_plausible_date"](value) == expected


# A CSV holds text only, so the Azure collector sees the string cases.
@pytest.mark.parametrize(("value", "expected"), [c for c in CASES if c[0] is None or isinstance(c[0], str)])
def test_azure_collector_matches_core(value, expected):
    con = duckdb.connect()
    con.execute('CREATE TEMP TABLE landed ("Date created" VARCHAR, "Last Activity Date" VARCHAR, '
                '"Last updated" VARCHAR)')
    con.execute("INSERT INTO landed VALUES (?, ?, ?)", [value, value, value])
    blanked = agent365._blank_implausible_dates(con)
    assert con.execute("SELECT * FROM landed").fetchone() == (expected, expected, value)
    assert blanked == (2 if value is not None and expected is None else 0)
    assert agent365.DATE_COLUMNS == ("Date created", "Last Activity Date")


@pytest.mark.parametrize("value", ["0001-01-01", "1/1/0001 12:00:00 AM", "12345 2026", "x0001", "2026-0001",
                                   "20260101", "99999", "abc", "", "0001\n2026", "Created 1999 or 2026", "1234"])
def test_azure_year_pattern_matches_core(value):
    match = re.search(dates.YEAR_PATTERN, value)
    found = duckdb.execute("SELECT regexp_extract(?, ?, 1)", [value, agent365.YEAR_SQL_PATTERN]).fetchone()[0]
    assert found == (match.group(1) if match else "")


@pytest.mark.parametrize("notebook", [REGISTRY, LANDER])
def test_notebook_constants_match_core(notebook):
    ns = notebook_source.namespace(notebook, CONSTANTS)
    assert ns["MIN_PLAUSIBLE_YEAR"] == dates.MIN_PLAUSIBLE_YEAR
    assert ns["YEAR_PATTERN"] == dates.YEAR_PATTERN


def test_registry_rows_guard_date_created_and_last_activity():
    row_cell = next(s for s in _cell_sources(REGISTRY) if "'Date created':" in s)
    for field in ("createdDateTime", "lastUsedDateTime"):
        assert f"_plausible_date(detail.get('{field}'))" in row_cell
    # 'Last updated' keys history and stamps changes, so it stays as sent.
    assert "_plausible_date(detail.get('lastModifiedDateTime'))" not in row_cell


def test_lander_blanks_dates_before_snapshot_as_of_and_write():
    ns = notebook_source.namespace(LANDER, CONSTANTS)
    assert ns["DATE_COLUMNS"] == ("Date created", "Last Activity Date")
    cell = next(s for s in _cell_sources(LANDER) if "def _blank_implausible_dates" in s)
    blank = cell.index("df, dates_blanked = _blank_implausible_dates(df)")
    assert blank < cell.index("row_count = df.count()")
    assert blank < cell.index("as_of = df.agg(")
    assert blank < cell.index("saveAsTable(OUTPUT_TABLE)")
