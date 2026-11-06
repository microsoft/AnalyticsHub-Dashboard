"""Agent 365 registry by CSV on Azure (module `agent365`): the collector against the Fabric Lander's
rules, the drop folder (storage and SharePoint), the curated agent link, publish targets and the V009
migration. HTTP is faked at the session level; Azure SQL is stood in for by sqlite3."""
from __future__ import annotations

import os
import re
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import duckdb
import pytest

import notebook_source
from test_azure_consumption import G, Resp, _sharepoint_handler, make_api
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import csvfile
from valuelens_jobs import publish as pub
from valuelens_jobs import sql as sql_mod
from valuelens_jobs.collect import agent365
from valuelens_jobs.config import Settings
from valuelens_jobs.storage import AdlsStore, LocalStore

ROOT = notebook_source.ROOT
V009 = ROOT / "azure" / "sql" / "migrations" / "V009__agent365.sql"
SAMPLE = ROOT / "samples" / "agents_365_sample.csv"
LANDER = "Copilot_Agent365_Lander.ipynb"
PARQUET = "raw/agents_365/part-0.parquet"
SITE = "contoso.sharepoint.com,1111,2222"
ON = Settings(modules=frozenset({"agent365"}))
SAMPLE_EXTRAS = ["Channel", "Creator Id", "Environment Id", "Bot Id", "Custom action list", "Instructions",
                 "Groups shared", "Users shared", "Entra Agent ID", "Is Blocked", "Agent creator UPN",
                 "Agent creator source"]
SAMPLE_MISSING = ["Publisher", "Active Users", "Total sessions", "Exception rate", "Last Activity Date",
                  "Deployment", "Run Time", "Risks"]


def write(path: Path, text: str, *, bom: bool = False) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))
    return path


def landed(store):
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{store.path(PARQUET).as_posix()}')")
    return rel.columns, [dict(zip(rel.columns, r)) for r in rel.fetchall()]


def by_title(store):
    return {r["Title ID"]: r for r in landed(store)[1]}


# ---------------------------------------------------------------- the Fabric Lander's rules
def test_canonical_columns_aliases_and_dates_match_the_lander():
    ns = notebook_source.namespace(LANDER, {"DATE_COLUMNS"})
    canonical, aliases = ns["_build_alias_plan"]()
    assert agent365.CANONICAL == canonical
    assert agent365.ALIASES == aliases
    assert agent365.DATE_COLUMNS == ns["DATE_COLUMNS"]
    for header in ("Title ID", "title_id", " Agent creator ID ", "Agent type (A365)", "Can read OneDrive files"):
        assert agent365.norm(header) == ns["_norm"](header)


@pytest.mark.parametrize("header", [
    csvfile.header(SAMPLE),
    ["Name", "TitleId", "Owner", "Developer", "Last Modified", "Created on", "Runtime", "Risk"],
    ["Display name", "Package ID", "Publisher name", "Type", "Sessions", "Last used", "Error rate", "Notes"],
    ["agent NAME", "creator_id", "Supported Platforms", "Deployment status", "Published to"],
])
def test_alias_resolution_matches_the_lander(header):
    ns = notebook_source.namespace(LANDER)
    canonical, aliases = ns["_build_alias_plan"]()
    expected = ns["_resolve_alias_targets"](header, aliases, canonical)
    assert {t: header[i] for t, i in agent365.resolve(header, range(len(header))).items()} == expected


# ---------------------------------------------------------------- landing
def test_land_the_sample_export(tmp_path):
    store = LocalStore(tmp_path)
    out = agent365.land(store, SAMPLE)
    assert out == {"file": SAMPLE.name, "rows": 104, "columns": 50, "via_alias": 0, "missing": SAMPLE_MISSING,
                   "extras": 12, "dates_blanked": 0, "snapshot_as_of": "2026-09-30T14:30:00"}
    assert store.list("raw/agents_365") == [PARQUET]
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{store.path(PARQUET).as_posix()}')")
    # The canonical columns first, then every other export column as sent, then the snapshot stamp.
    assert rel.columns == agent365.CANONICAL + SAMPLE_EXTRAS + ["Snapshot As Of"]
    assert {str(t) for t in rel.types[:-1]} == {"VARCHAR"} and str(rel.types[-1]) == "TIMESTAMP"
    row = by_title(store)["T_1001"]
    assert row["Agent name"] == "HR Onboarding Agent" and row["Channel"] == "Microsoft Teams"
    assert row["Agent description"] == ("Agent Builder agent for hr & people requests, grounded in "
                                        "Microsoft 365 content.")
    assert row["Publisher"] is None and row["Snapshot As Of"] == datetime(2026, 9, 30, 14, 30)


def test_aliases_are_copies_and_the_source_columns_stay(tmp_path):
    csv = write(tmp_path / "a.csv", "Name,TitleId,Last Modified,Created on,Owner,Notes\n"
                                    "Helper,T_1,2026-09-01T10:00:00Z,2026-01-02,Ana,first\n")
    store = LocalStore(tmp_path / "s")
    out = agent365.land(store, csv)
    columns, [row] = landed(store)
    assert out["via_alias"] == 5 and out["extras"] == 6
    assert columns[len(agent365.CANONICAL):] == ["Name", "TitleId", "Last Modified", "Created on", "Owner",
                                                 "Notes", "Snapshot As Of"]
    assert row["Agent name"] == row["Name"] == "Helper"
    assert row["Title ID"] == row["TitleId"] == "T_1"
    assert row["Last updated"] == row["Last Modified"] == "2026-09-01T10:00:00Z"
    assert row["Date created"] == "2026-01-02" and row["Agent creator"] == "Ana"


def test_headers_equal_once_normalised_are_kept_once_when_their_values_match(tmp_path):
    csv = write(tmp_path / "a.csv", "title_id,Title ID,agent name,Agent Name\nT_1,T_1,Helper,Helper\n,,x,x\n")
    store = LocalStore(tmp_path / "s")
    out = agent365.land(store, csv)
    columns, rows = landed(store)
    # The canonical spelling wins ('Title ID'); with none, the first ('agent name', copied to 'Agent name').
    assert columns == agent365.CANONICAL + ["Snapshot As Of"]
    assert out["via_alias"] == 1 and out["extras"] == 0
    assert sorted((r["Title ID"] or "", r["Agent name"]) for r in rows) == [("", "x"), ("T_1", "Helper")]


def test_headers_equal_once_normalised_with_different_values_fail(tmp_path):
    csv = write(tmp_path / "a.csv", "Title ID,TitleId\nT_1,T_2\n")
    store = LocalStore(tmp_path / "s")
    with pytest.raises(ValueError, match=re.escape("Ambiguous source headers after normalization: "
                                                   "['Title ID', 'TitleId']")):
        agent365.land(store, csv)
    assert store.list("raw/agents_365") == []


def test_dates_before_2000_load_blank_and_last_updated_stays(tmp_path):
    csv = write(tmp_path / "a.csv", "Title ID,Date created,Last used,Last updated\n"
                                    "T_1,0001-01-01T00:00:00Z,1/1/0001 12:00:00 AM,0001-01-01T00:00:00Z\n"
                                    "T_2,2026-01-02T00:00:00Z,9/10/2026 8:00:00 AM,2026-09-10T08:00:00Z\n")
    store = LocalStore(tmp_path / "s")
    out = agent365.land(store, csv)
    rows = by_title(store)
    assert out["dates_blanked"] == 2
    assert rows["T_1"]["Date created"] is None and rows["T_1"]["Last Activity Date"] is None
    # Only the canonical copies are guarded: the export's own column and 'Last updated' stay as sent.
    assert rows["T_1"]["Last used"] == "1/1/0001 12:00:00 AM"
    assert rows["T_1"]["Last updated"] == "0001-01-01T00:00:00Z"
    assert rows["T_2"]["Date created"] == "2026-01-02T00:00:00Z"
    assert rows["T_2"]["Last Activity Date"] == "9/10/2026 8:00:00 AM"


def test_snapshot_as_of_is_the_latest_last_updated_in_utc(tmp_path):
    csv = write(tmp_path / "a.csv", "Title ID,Last updated\nT_1,2026-09-01T10:00:00Z\n"
                                    "T_2,2026-09-02T01:30:00+02:00\nT_3,not a date\nT_4,\n")
    store = LocalStore(tmp_path / "s")
    assert agent365.land(store, csv)["snapshot_as_of"] == "2026-09-01T23:30:00"
    assert {r["Snapshot As Of"] for r in landed(store)[1]} == {datetime(2026, 9, 1, 23, 30)}

    undated = write(tmp_path / "b.csv", "Title ID\nT_1\n")
    assert agent365.land(store, undated)["snapshot_as_of"] is None
    assert [r["Snapshot As Of"] for r in landed(store)[1]] == [None]


def test_reads_exports_as_the_fabric_csv_reader_does(tmp_path):
    # A BOM, padded and empty headers, a quoted line break and comma, a short row and a long row.
    csv = write(tmp_path / "a.csv", " Title ID ,Agent name,Agent description,\n"
                                    'T_1,Helper,"Line one\nline two, with a comma",x\n'
                                    "T_2,Short\n"
                                    "T_3,Long,desc,extra,cut\n"
                                    'T_4,"",\n', bom=True)
    store = LocalStore(tmp_path / "s")
    assert agent365.land(store, csv)["rows"] == 4
    rows = by_title(store)
    assert rows["T_1"]["Agent description"] == "Line one\nline two, with a comma" and rows["T_1"]["_c3"] == "x"
    assert rows["T_2"]["Agent name"] == "Short" and rows["T_2"]["Agent description"] is None
    assert rows["T_3"]["_c3"] == "extra" and "cut" not in rows["T_3"].values()
    assert rows["T_4"]["Agent name"] is None


@pytest.mark.parametrize("text", ["", "Title ID,Agent name\n", "Title ID,Agent name\n\n\n"])
def test_an_export_with_no_rows_never_empties_the_table(tmp_path, text):
    store = LocalStore(tmp_path / "s")
    empty = write(tmp_path / "empty.csv", text)
    with pytest.raises(ValueError, match=r"empty\.csv parsed 0 rows; refusing to write an empty snapshot"):
        agent365.land(store, empty)
    assert store.list("raw/agents_365") == []
    agent365.land(store, SAMPLE)
    before = store.path(PARQUET).read_bytes()
    with pytest.raises(ValueError, match=r"parsed 0 rows; refusing to replace the existing agents_365"):
        agent365.land(store, empty)
    assert store.path(PARQUET).read_bytes() == before


def test_headers_too_long_for_a_sql_column_are_dropped(tmp_path, caplog):
    too_long, longest = "x" * 129, "y" * 128
    csv = write(tmp_path / "a.csv", f"Title ID,{too_long},{longest}\nT_1,a,b\n")
    store = LocalStore(tmp_path / "s")
    assert agent365.land(store, csv)["extras"] == 1
    columns, _ = landed(store)
    assert longest in columns and too_long not in columns
    assert "longer than 128 characters" in caplog.text


# ---------------------------------------------------------------- the drop folder
def test_newest_is_by_modified_time_then_name():
    assert agent365.newest([]) is None
    assert agent365.newest([("notes.txt", "9")]) is None
    files = [("a.csv", None), ("b.CSV", "100.5"), ("c.csv", "1970-01-01T00:02:00Z"), ("d.txt", "999")]
    assert agent365.newest(files) == "c.csv"
    assert agent365.newest([("agents_1.csv", "5"), ("agents_2.csv", "5"), ("agents_0.csv", None)]) == "agents_2.csv"
    assert agent365.newest([("x.csv", "not a time"), ("w.csv", None)]) == "x.csv"


def test_collect_reads_the_newest_export_in_landing(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.agent365")
    store = LocalStore(tmp_path)
    folder = tmp_path / "landing" / "agent365"
    old = write(folder / "b-old.csv", "Title ID,Agent name\nT_OLD,Old\n")
    new = write(folder / "a-new.csv", "Title ID,Agent name\nT_NEW,New\nT_TWO,Two\n")
    note = write(folder / "notes.txt", "not an export")
    nested = write(folder / "archive" / "z.csv", "Title ID\nT_NESTED\n")
    for path, stamp in ((old, 1_000), (new, 2_000), (note, 3_000), (nested, 4_000)):
        os.utime(path, (stamp, stamp))
    out = agent365.collect_agent365(None, store, ON)
    assert out["file"] == "a-new.csv" and out["rows"] == 2
    assert set(by_title(store)) == {"T_NEW", "T_TWO"}
    assert "1 older CSV(s) ignored" in caplog.text
    assert old.exists() and new.exists()  # the drop folder is never changed


def test_collect_without_an_export_leaves_the_table(tmp_path):
    store = LocalStore(tmp_path)
    agent365.land(store, SAMPLE)
    before = store.path(PARQUET).read_bytes()
    write(tmp_path / "landing" / "agent365" / "notes.txt", "not an export")
    assert agent365.collect_agent365(None, store, ON) == {"file": None}
    assert store.path(PARQUET).read_bytes() == before


def test_collect_reads_the_newest_export_from_sharepoint(tmp_path):
    def stale():
        raise AssertionError("downloaded an older export")

    routes = {
        f"{G}/sites/{SITE}": Resp(200, {"id": SITE}),
        f"{G}/drives/b!drive/root:/ValueLens/agent365:/children": Resp(200, {"value": [
            {"name": "agents-old.csv", "id": "o1", "lastModifiedDateTime": "2026-09-01T08:00:00Z"},
            {"name": "agents-new.csv", "id": "n1", "lastModifiedDateTime": "2026-09-30T08:00:00Z"},
            {"name": "readme.txt", "id": "t1", "lastModifiedDateTime": "2026-10-01T08:00:00Z"},
            {"name": "archive", "id": "f1", "folder": {}},
        ]}),
        f"{G}/drives/b!drive/items/n1/content": Resp(200, content=b"Title ID,Agent name\nT_SP,From SharePoint\n"),
        f"{G}/drives/b!drive/items/o1/content": stale,
    }
    api, session = make_api(_sharepoint_handler(routes))
    settings = Settings(modules=frozenset({"agent365"}), drop_site_id=SITE, drop_drive_id="b!drive",
                        drop_folder="ValueLens")
    store = LocalStore(tmp_path)
    out = agent365.collect_agent365(api, store, settings)
    assert out["file"] == "agents-new.csv" and out["rows"] == 1
    assert by_title(store)["T_SP"]["Agent name"] == "From SharePoint"
    assert not (tmp_path / "landing").exists()
    assert sum(1 for c in session.calls if c[1].endswith("/content")) == 1


class FakeBlobService:
    """Blob containers in memory: {(container, name): (bytes, last modified)}."""

    def __init__(self):
        self.blobs = {}

    def get_container_client(self, container):
        return FakeContainer(self, container)


class FakeContainer:
    def __init__(self, service, container):
        self.service, self.container = service, container

    def list_blobs(self, name_starts_with, include=None):
        return [SimpleNamespace(name=n, metadata={}, last_modified=m)
                for (c, n), (_, m) in sorted(self.service.blobs.items())
                if c == self.container and n.startswith(name_starts_with)]

    def download_blob(self, name):
        data = self.service.blobs[(self.container, name)][0]
        return SimpleNamespace(readinto=lambda fh: fh.write(data))

    def upload_blob(self, name, fh, overwrite=False):
        self.service.blobs[(self.container, name)] = (fh.read(), datetime.now(timezone.utc))

    def delete_blob(self, name):
        del self.service.blobs[(self.container, name)]


def test_adls_pull_keeps_the_upload_time_so_the_newest_upload_wins(tmp_path):
    uploaded = datetime(2026, 9, 30, 8, tzinfo=timezone.utc)
    service = FakeBlobService()
    # The newer upload sorts first by name, so only the upload time can pick it.
    service.blobs[("landing", "agent365/a-new.csv")] = (b"Title ID\nT_NEW\n", uploaded)
    service.blobs[("landing", "agent365/z-old.csv")] = (b"Title ID\nT_OLD\n", datetime(2026, 9, 1, tzinfo=timezone.utc))
    store = AdlsStore("acct", root=tmp_path, service=service)
    out = agent365.collect_agent365(None, store, ON)
    assert out["file"] == "a-new.csv"
    assert store.path("landing/agent365/a-new.csv").stat().st_mtime == uploaded.timestamp()
    assert ("raw", "agents_365/part-0.parquet") in service.blobs
    assert set(by_title(store)) == {"T_NEW"}


# ---------------------------------------------------------------- the curated agent link
def test_a_landed_export_links_agents_in_the_curated_table(tmp_path):
    from valuelens_jobs import sample

    store = LocalStore(tmp_path)
    sample.load(store, folder=ROOT / "samples", today=date(2026, 10, 6))
    agent365.land(store, SAMPLE)
    assert jobs_main.process(store) > 0
    curated = f"read_parquet('{store.path(jobs_main.CURATED_PREFIX).as_posix()}/*.parquet', union_by_name=true)"
    linked = {r[0] for r in duckdb.sql(f"SELECT DISTINCT Agent_LinkID FROM {curated} "
                                       "WHERE Agent_LinkID IS NOT NULL").fetchall()}
    assert linked and linked <= set(by_title(store))


# ---------------------------------------------------------------- wiring, publish and V009
def test_collect_wiring_and_publish_targets(tmp_path, monkeypatch):
    from valuelens_jobs.collect import audit, graph, resource_graph

    called = []
    for mod, name in ((graph, "collect_licensed"), (audit, "collect_audit"), (agent365, "collect_agent365"),
                      (resource_graph, "collect_resource_graph")):
        monkeypatch.setattr(mod, name, lambda *a, _n=name, **k: called.append(_n))
    store = LocalStore(tmp_path)
    jobs_main.collect(store, Settings(modules=frozenset({"core"})), api=object())
    assert called == ["collect_licensed", "collect_audit"]
    called.clear()
    jobs_main.collect(store, Settings(modules=frozenset({"core", "agent365", "resourceGraph"})), api=object())
    # Before Resource Graph, which maps agents to their Agent 365 titles through this table. Audit runs last.
    assert called == ["collect_licensed", "collect_agent365", "collect_resource_graph", "collect_audit"]

    assert Settings.from_env({"VALUELENS_MODULES": "core,agent365"}).has("agent365")
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core", "agent365"}))) == [
        "curated", "licensed", "agents_365"]
    assert "agents_365" not in jobs_main.publish_targets(Settings(modules=frozenset({"core"})))
    # Demo mode publishes only the sample, so the table keeps what it had.
    assert "agents_365" not in jobs_main.publish_targets(
        Settings(modules=frozenset({"core", "agent365"}), sample_data=True))
    t = pub.TARGETS["agents_365"]
    assert (t.table, t.prefix, t.partition, t.incremental) == ("agents_365", "raw/agents_365", None, False)


def _v009():
    sql = V009.read_text(encoding="utf-8")
    [(name, body)] = re.findall(r"CREATE TABLE dbo\.(\w+) \((.*?)\n\);", sql, re.S)
    return sql, name, re.findall(r"\[([^\]]+)\] ([A-Z0-9]+(?:\(\d+\))?) NULL", body)


def test_v009_creates_agents_365_with_the_canonical_columns():
    sql, name, columns = _v009()
    assert name == agent365.TABLE == pub.TARGETS["agents_365"].table
    assert columns == [(c, pub.sql_type("VARCHAR")) for c in agent365.CANONICAL] + [
        (agent365.SNAPSHOT_COLUMN, pub.sql_type("TIMESTAMP"))]
    assert "IF OBJECT_ID(N'dbo.agents_365', N'U') IS NULL" in sql
    assert "WHERE version = 9)" in sql and "VALUES (9," in sql
    assert len(sql_mod.batches(sql)) == 2
    assert dict(sql_mod.migrations(V009.parent))[9] == V009


def test_publish_onto_the_v009_table_in_sqlite(tmp_path):
    _, name, columns = _v009()
    conn = sqlite3.connect(":memory:")
    conn.execute(f"CREATE TABLE [{name}] ({', '.join(f'[{c}] {t} NULL' for c, t in columns)})")
    store = LocalStore(tmp_path / "s")
    agent365.land(store, SAMPLE)
    [result] = pub.publish(conn, store, ["agents_365"])
    assert result["rows"] == 104 and result["added_columns"] == SAMPLE_EXTRAS
    row = conn.execute("SELECT [Agent name], [Channel], [Snapshot As Of] FROM agents_365 "
                       "WHERE [Title ID] = 'T_1001'").fetchone()
    assert row[:2] == ("HR Onboarding Agent", "Microsoft Teams") and str(row[2]).startswith("2026-09-30 14:30")

    # The next export replaces every row; a column it no longer has stays, blank.
    agent365.land(store, write(tmp_path / "next.csv", "Title ID,Agent name\nT_9,Only one\n"))
    [result] = pub.publish(conn, store, ["agents_365"])
    assert result == {"table": "agents_365", "rows": 1, "added_columns": []}
    assert conn.execute("SELECT [Title ID], [Channel] FROM agents_365").fetchall() == [("T_9", None)]
