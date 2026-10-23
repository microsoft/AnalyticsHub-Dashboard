"""The templates in sharepoint/ are unchanged copies, each pinned in provenance.json.

sharepoint/ holds Power BI templates copied byte for byte from other repositories, for a
SharePoint setup. Nothing ships them yet. These tests check each copy against its record, that
the ValueLens model keeps the shape it was pinned with, and that
scripts/Check-SharePoint-Queries.py still reads this repository.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import zipfile
from pathlib import Path

import pytest

from test_core_templates import FORBIDDEN_PARTS, LOCAL_PATH, text

ROOT = Path(__file__).resolve().parents[1]
FOLDER = ROOT / "sharepoint"
RECORDS = json.loads((FOLDER / "provenance.json").read_text(encoding="utf-8"))
# Files in sharepoint/ that aren't copies.
OWN_FILES = {"README.md", "provenance.json"}
RECORD_KEYS = {"repository", "path", "commit", "gitBlob", "sha256", "bytes"}
HEX_LENGTHS = {"commit": 40, "gitBlob": 40, "sha256": 64}
# A template may name only the placeholder SharePoint site, never a real one.
SITE = re.compile(r"([\w-]+)\.sharepoint\.com", re.IGNORECASE)
PLACEHOLDER_SITES = {"contoso"}

VALUELENS = "ValueLens - SharePoint.pbit"
# The ValueLens model as pinned. A re-pin that changes the model updates these.
TABLES, COLUMNS, MEASURES, RELATIONSHIPS = 20, 188, 202, 8
CORE_TABLES = {"Chat + Agent Interactions (Audit Logs)", "Copilot Licensed", "Chat + Agent Org Data", "Calendar",
               "Agents 365", "Behavior Value Map", "Human Time Estimates", "ProductFeedback"}
# Every parameter ships blank. True marks the ones the template can't open without.
PARAMETERS = {"Copilot Interactions File": True, "Org Data File": True, "SharePoint Site URL": True,
              "Agent 365": False, "Feedback File": False}
NEITHER = "in neither AH's Fabric template nor the installer"

spec = importlib.util.spec_from_file_location("check_sharepoint_queries",
                                              ROOT / "scripts" / "Check-SharePoint-Queries.py")
check_script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_script)

# A small model for the script's unit tests.
MODEL = check_script.catalog({"tables": [
    {"name": "Calendar", "columns": [{"name": "Date"}, {"name": "Month"}]},
    {"name": "Usage", "columns": [{"name": "User"}], "measures": [{"name": "Total Users"}]},
]})


def git_blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


@pytest.fixture(scope="module")
def valuelens():
    with zipfile.ZipFile(FOLDER / VALUELENS) as archive:
        return json.loads(archive.read("DataModelSchema").decode("utf-16-le"))["model"]


# ---------------------------------------------------------------- the copies
def test_every_copy_has_a_record_and_every_record_a_copy():
    copies = {p.relative_to(FOLDER).as_posix() for p in FOLDER.rglob("*") if p.is_file()} - OWN_FILES
    assert copies == set(RECORDS)


@pytest.mark.parametrize("name", sorted(RECORDS))
def test_record_is_complete(name):
    record = RECORDS[name]
    assert set(record) == RECORD_KEYS
    assert re.fullmatch(r"[\w.-]+/[\w.-]+", record["repository"])
    assert record["path"] and not record["path"].startswith("/")
    for key, length in HEX_LENGTHS.items():
        assert re.fullmatch(rf"[0-9a-f]{{{length}}}", record[key]), key
    assert type(record["bytes"]) is int and record["bytes"] > 0


@pytest.mark.parametrize("name", sorted(RECORDS))
def test_copy_matches_its_record(name):
    data = (FOLDER / name).read_bytes()
    found = {"gitBlob": git_blob(data), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    pinned = {key: RECORDS[name][key] for key in found}
    assert found == pinned, f"{name} doesn't match its record in provenance.json: see sharepoint/README.md"


@pytest.mark.parametrize("name", sorted(n for n in RECORDS if n.endswith(".pbit")))
def test_template_is_portable(name):
    with zipfile.ZipFile(FOLDER / name) as archive:
        assert archive.testzip() is None
        members = {n: archive.read(n) for n in archive.namelist()}
    assert [part for part in FORBIDDEN_PARTS if part in members] == []
    texts = {"DataModelSchema": members["DataModelSchema"].decode("utf-16-le")}
    texts.update((n, data.decode("utf-8")) for n, data in members.items() if n.startswith("Report/definition/"))
    assert [part for part, value in texts.items() if LOCAL_PATH.search(value)] == []
    sites = {site.casefold() for value in texts.values() for site in SITE.findall(value)}
    assert sites <= PLACEHOLDER_SITES


def test_valuelens_model_keeps_its_shape(valuelens):
    tables = valuelens["tables"]
    shape = (len(tables),
             sum(1 for t in tables for c in t.get("columns", []) if c.get("type") != "rowNumber"),
             sum(len(t.get("measures", [])) for t in tables),
             len(valuelens.get("relationships", [])))
    assert shape == (TABLES, COLUMNS, MEASURES, RELATIONSHIPS)
    assert CORE_TABLES - {t["name"] for t in tables} == set()


def test_valuelens_parameters_ship_blank(valuelens):
    found = {}
    for expression in valuelens.get("expressions", []):
        value, _, meta = text(expression["expression"]).partition(" meta ")
        meta = meta.replace(" ", "")
        if "IsParameterQuery=true" in meta:
            found[expression["name"]] = (value.strip(), "IsParameterQueryRequired=true" in meta)
    assert found == {name: ("null", required) for name, required in PARAMETERS.items()}


# ---------------------------------------------------------------- scripts/Check-SharePoint-Queries.py
def test_query_reads_names_and_local_definitions():
    dax = """
    DEFINE
        VAR __Start = DATE(2026, 1, 1)
        MEASURE 'Calendar'[Local Rate] = DIVIDE([Total Users], 2)
        TABLE Pairs = {(1, 2)}
    EVALUATE
    SUMMARIZECOLUMNS('Calendar'[Month], "Rows", [Total Users], "Rate", [Local Rate])
    // 'Ignored'[Comment]
    """
    query = check_script.Query(dax)
    assert ("Calendar", "Month") in query.refs
    assert (None, "Local Rate") in query.refs
    assert not [ref for ref in query.refs if "Ignored" in ref]
    assert query.names == {"__start", "pairs"}
    assert query.defined == {"calendar": {"local rate"}}
    assert {"rows", "rate"} <= query.strings
    assert check_script.check(dax, MODEL, None, []) == ([], [])


def test_check_lists_what_the_model_lacks():
    dax = """
    EVALUATE
    SUMMARIZECOLUMNS(
        'Calendar'[Month], 'Calendar'[Week], 'Calendar'[Total Users],
        'Missing'[A], 'Missing'[B], 'Usage'[__COLUMN__],
        "Users", [Total Users], "Other", [Nope]
    )
    """
    missing, run_time = check_script.check(dax, MODEL, None, [])
    assert missing == [
        {"name": "'Calendar'[Total Users]", "problem": "a measure on 'Usage'", "origin": NEITHER},
        {"name": "'Calendar'[Week]", "problem": "no such column", "origin": NEITHER},
        {"name": "'Missing'", "problem": "no such table", "origin": NEITHER, "columns": ["A", "B"]},
        {"name": "[Nope]", "problem": "no such measure", "origin": NEITHER},
    ]
    assert run_time == ["__COLUMN__"]


def test_check_knows_the_columns_dax_makes():
    stats = 'EVALUATE SELECTCOLUMNS(COLUMNSTATISTICS(), "T", [Table Name], "C", [Column Name])'
    assert check_script.check(stats, MODEL, None, []) == ([], [])
    plain = 'EVALUATE SELECTCOLUMNS({1}, "T", [Table Name], "V", [Value])'
    assert [m["name"] for m in check_script.check(plain, MODEL, None, [])[0]] == ["[Table Name]"]


def test_origin_prefers_the_file_that_defines_a_name():
    installer = [
        ("installer/src/access.js", "export const TABLES = ['Load Log', 'Usage Daily'];"),
        ("installer/src/transform/usage.js", "export const USAGE_TABLE = 'Usage Daily';"),
    ]
    fabric = check_script.catalog({"tables": [{"name": "Load Log", "columns": [{"name": "Run"}]}]})
    query = check_script.Query("")

    def origin(table, fabric_model=None):
        return check_script.origin(table, None, "no such table", query, fabric_model, installer)

    assert origin("Usage Daily") == "added by installer/src/transform/usage.js"
    assert origin("Load Log") == "named in installer/src/access.js"
    assert origin("Load Log", fabric) == "in AH's Fabric template"
    assert origin("Elsewhere") == NEITHER


def write(root, relative, content):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_attribute_follows_connections_through_imports(tmp_path):
    queries = "app/src/queries"
    write(tmp_path, f"{queries}/shared.ts", 'export const vlConnection = "vl";\nexport const ccConnection = "cc";\n')
    # An aliased connection, and a helper module with no connection of its own.
    write(tmp_path, f"{queries}/adoption/index.ts",
          'import { vlConnection as conn } from "../shared";\n'
          'import { run } from "../helpers/run";\n'
          'import users from "./users.dax?raw";\n'
          'export const usersQuery = { query: users, connection: conn };\n')
    write(tmp_path, f"{queries}/helpers/run.ts",
          'import totals from "./totals.dax?raw";\n'
          'export function run() { return totals; }\n')
    # One module, two connections: each query goes where its own object says.
    write(tmp_path, f"{queries}/mixed/index.ts",
          'import { vlConnection, ccConnection } from "../shared";\n'
          'import usage from "./usage.dax?raw";\n'
          'import credits from "./credits.dax?raw";\n'
          'export const usageQuery = { query: usage, connection: vlConnection };\n'
          'export const creditsQuery = { query: credits, connection: ccConnection };\n')
    for name in ("adoption/users", "helpers/totals", "mixed/usage", "mixed/credits"):
        write(tmp_path, f"{queries}/{name}.dax", 'EVALUATE ROW("x", 1)\n')

    sent, in_code = check_script.attribute(tmp_path)

    assert sent == {
        f"{queries}/adoption/users.dax": {"vl"},
        f"{queries}/helpers/totals.dax": {"vl"},
        f"{queries}/mixed/credits.dax": {"cc"},
        f"{queries}/mixed/usage.dax": {"vl"},
    }
    assert in_code == []


def test_report_on_this_repository(capsys):
    assert check_script.main(["--json"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["problems"] == []
    assert result["model"]["commit"] == RECORDS[VALUELENS]["commit"]
    assert result["model"]["measures"] == MEASURES
    assert result["queries"], "found no ValueLens queries"


def test_report_without_a_template(tmp_path, capsys):
    assert check_script.main(["--root", str(tmp_path)]) == 0
    assert "Problem: Can't read sharepoint/ValueLens - SharePoint.pbit" in capsys.readouterr().out
