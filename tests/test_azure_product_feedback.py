"""Product feedback by CSV on Azure (module `productFeedback`): the collector against the Fabric
ingester's rules, the drop folder (storage and SharePoint), publish targets and the V010 migration.
HTTP is faked at the session level; Azure SQL is stood in for by sqlite3."""
from __future__ import annotations

import re
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb
import pytest

import notebook_source
from test_azure_agent365 import FakeBlobService
from test_azure_consumption import G, Resp, _sharepoint_handler, make_api
from valuelens_jobs import __main__ as jobs_main
from valuelens_jobs import csvfile
from valuelens_jobs import publish as pub
from valuelens_jobs import sql as sql_mod
from valuelens_jobs.collect import product_feedback as feedback
from valuelens_jobs.config import Settings
from valuelens_jobs.storage import AdlsStore, LocalStore

ROOT = notebook_source.ROOT
V010 = ROOT / "azure" / "sql" / "migrations" / "V010__product_feedback.sql"
SAMPLE = ROOT / "samples" / "product_feedback_sample.csv"
INGESTER = "Copilot_ProductFeedback_Ingester.ipynb"
PARQUET = "raw/user_feedback/part-0.parquet"
SITE = "contoso.sharepoint.com,1111,2222"
ON = Settings(modules=frozenset({"productFeedback"}))
NOW = datetime(2026, 10, 6, 7, 30, tzinfo=timezone.utc)
FROWN = "9d067796-0c9a-4a7c-a3b2-63863098a52e"  # a sample row


def write(path: Path, text: str, *, bom: bool = False) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))
    return path


def landed(store):
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{store.path(PARQUET).as_posix()}')")
    return rel.columns, [dict(zip(rel.columns, r)) for r in rel.fetchall()]


def by_id(store):
    return {r["Feedback Id"]: r for r in landed(store)[1]}


# ---------------------------------------------------------------- the Fabric ingester's rules
def test_columns_folder_and_sentiment_words_match_the_ingester():
    ns = notebook_source.namespace(INGESTER, {"SOURCE_DIR", "TARGET_TABLE", "EMPTY_SCHEMA", "_POS", "_NEG"})
    assert feedback.COLUMNS == ns["EMPTY_SCHEMA"]
    assert ns["SOURCE_DIR"].rsplit("/", 1)[-1] == feedback.SUBDIR
    assert ns["TARGET_TABLE"] == f"dbo.{feedback.TABLE}"
    assert (feedback.POSITIVE, feedback.NEGATIVE) == (ns["_POS"], ns["_NEG"])
    # The sample is the export as the admin center sends it: the model's columns but the derived two.
    assert csvfile.header(SAMPLE) == [c for c in feedback.COLUMNS if c not in feedback.DERIVED]


def test_with_no_export_the_table_stays_as_the_ingester_preserves_it(tmp_path):
    ns = notebook_source.namespace(INGESTER, {"SOURCE_DIR", "REPORT_GLOB", "TARGET_TABLE"})
    assert ns["_decide_missing_feedback_action"]([], True, False, False)["action"] == "preserve"
    store = LocalStore(tmp_path)
    feedback.land(store, [SAMPLE], now=NOW)
    before = store.path(PARQUET).read_bytes()
    write(tmp_path / "landing" / "product_feedback" / "notes.txt", "Feedback Id\nf1\n")
    assert feedback.collect_product_feedback(None, store, ON) == {"files": 0}
    assert store.path(PARQUET).read_bytes() == before


# ---------------------------------------------------------------- landing
def test_land_the_sample_export(tmp_path):
    store = LocalStore(tmp_path)
    out = feedback.land(store, [SAMPLE], now=NOW)
    assert out == {"files": 1, "rows": 1215, "duplicates": 0, "columns": 25, "extras": 0, "missing": [],
                   "positive": 577, "negative": 352}
    assert store.list("raw/user_feedback") == [PARQUET]
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{store.path(PARQUET).as_posix()}')")
    assert rel.columns == feedback.COLUMNS + list(feedback.LINEAGE)
    types = dict(zip(rel.columns, map(str, rel.types)))
    assert types.pop(feedback.DATE_COLUMN) == "DATE" and set(types.values()) == {"VARCHAR"}
    _, rows = landed(store)
    assert all(r[feedback.DATE_COLUMN] is not None for r in rows)
    row = by_id(store)[FROWN]
    assert (row["Feedback Type"], row["Sentiment"], row["App"]) == ("Frown", "Negative", "Microsoft 365 Copilot")
    assert (row["Date Submitted UTC"], row["Date Submitted Date"]) == ("06/02/2025 14:47:25", date(2025, 6, 2))
    assert (row["SourceFile"], row["LoadDate"]) == (SAMPLE.name, "2026-10-06T07:30:00Z")


def test_dates_parse_as_the_ingester_does(tmp_path):
    csv = write(tmp_path / "a.csv", "Feedback Id,Date Submitted UTC\n"
                                    "f1,06/02/2025 13:46:40\n"
                                    "f2,6/2/2025 9:05:00\n"
                                    "f3,2025-06-02 23:59:59\n"
                                    "f4,2025-06-02T23:30:00-02:00\n"
                                    "f5,2025-06-02T13:46:40Z\n"
                                    "f6,yesterday\n"
                                    "f7,\n")
    store = LocalStore(tmp_path / "s")
    feedback.land(store, [csv], now=NOW)
    rows = by_id(store)
    # In UTC: the offset moves f4 to the next day. The text stays as exported.
    assert {k: r["Date Submitted Date"] for k, r in rows.items()} == {
        "f1": date(2025, 6, 2), "f2": date(2025, 6, 2), "f3": date(2025, 6, 2), "f4": date(2025, 6, 3),
        "f5": date(2025, 6, 2), "f6": None, "f7": None}
    assert rows["f4"]["Date Submitted UTC"] == "2025-06-02T23:30:00-02:00"


def test_sentiment_comes_from_the_feedback_type(tmp_path):
    kinds = {"p1": "Thumbs Up", "p2": " smile ", "p3": "LIKE", "p4": "Compliment", "p5": "positive",
             "n1": "Thumbs Down", "n2": "Frown", "n3": "dislike", "n4": "Complaint", "n5": "NEGATIVE",
             "x1": "Bug", "x2": "Thumbs-Up", "x3": ""}
    csv = write(tmp_path / "a.csv", "Feedback Id,Feedback Type\n" + "".join(f"{k},{v}\n" for k, v in kinds.items()))
    store = LocalStore(tmp_path / "s")
    out = feedback.land(store, [csv], now=NOW)
    assert (out["positive"], out["negative"]) == (5, 5)
    expected = {"p": "Positive", "n": "Negative", "x": None}
    assert {k: r["Sentiment"] for k, r in by_id(store).items()} == {k: expected[k[0]] for k in kinds}


def test_the_derived_columns_come_from_each_files_own_source_columns(tmp_path):
    # As the ingester's _enrich, file by file: derived when the file has the source column (replacing
    # a column of the same name), else the export's own column is kept.
    a = write(tmp_path / "a.csv", "Feedback Id,Feedback Type,Sentiment,Date Submitted UTC,Date Submitted Date\n"
                                  "f1,Thumbs Up,Negative,06/02/2025 13:46:40,1999-01-01\n")
    b = write(tmp_path / "b.csv", "Feedback Id,Sentiment,Date Submitted Date\n"
                                  "f2,Positive,2025-06-04\n"
                                  "f3,,06/05/2025 08:00:00\n")
    store = LocalStore(tmp_path / "s")
    feedback.land(store, [a, b], now=NOW)
    rows = by_id(store)
    assert (rows["f1"]["Sentiment"], rows["f1"]["Date Submitted Date"]) == ("Positive", date(2025, 6, 2))
    assert (rows["f2"]["Sentiment"], rows["f2"]["Date Submitted Date"]) == ("Positive", date(2025, 6, 4))
    assert (rows["f3"]["Sentiment"], rows["f3"]["Date Submitted Date"]) == (None, date(2025, 6, 5))


def test_exports_add_up_by_column_name_ignoring_case(tmp_path):
    a = write(tmp_path / "a.csv", "Feedback Id,Comment,App,Region\nf1,Great,Word,EU\n")
    b = write(tmp_path / "b.csv", "feedback id,APP,comment,region,Department\nf2,Excel,Slow,US,Finance\n")
    store = LocalStore(tmp_path / "s")
    out = feedback.land(store, [a, b], now=NOW)
    columns, _ = landed(store)
    # The model's columns, then other export columns in the first file's spelling, then the lineage.
    assert columns == feedback.COLUMNS + ["Region", "Department", "SourceFile", "LoadDate"]
    assert (out["files"], out["rows"], out["extras"]) == (2, 2, 2)
    assert "Translated Comment" in out["missing"] and "Comment" not in out["missing"]
    rows = by_id(store)
    assert (rows["f2"]["App"], rows["f2"]["Comment"], rows["f2"]["Region"]) == ("Excel", "Slow", "US")
    assert (rows["f1"]["Department"], rows["f1"]["SourceFile"], rows["f2"]["SourceFile"]) == (None, "a.csv", "b.csv")


def test_repeated_headers_are_numbered_as_spark_does(tmp_path):
    assert feedback.safe_header(["Feedback Id", "Comment", "comment", "App"]) == [
        "Feedback Id", "Comment1", "comment2", "App"]
    # A name the table knows takes its spelling: an export's own SourceFile is replaced by the lineage.
    assert feedback.safe_header(["feedback ID", "app", "sourcefile"]) == ["Feedback Id", "App", "SourceFile"]
    # The repeated 'Region' at position 1 becomes 'Region1', which the export already has.
    csv = write(tmp_path / "a.csv", "Feedback Id,Region,region,Region1\nf1,a,b,c\n")
    store = LocalStore(tmp_path / "s")
    with pytest.raises(ValueError, match=re.escape("Product feedback CSV a.csv: Ambiguous source headers after "
                                                   "numbering repeats: ['Region1']")):
        feedback.land(store, [csv], now=NOW)
    assert store.list("raw/user_feedback") == []


@pytest.mark.parametrize("files, message", [
    ({"a.csv": "Comment,App\nhello,Word\n"},
     "Feedback export is missing 'Feedback Id'; refusing to write an unstable snapshot."),
    ({"a.csv": "Feedback Id,Comment\nf1,ok\n,blank\n  ,spaces\n"},
     "Feedback export contains 2 blank Feedback Id value(s); refusing to dedupe an unstable snapshot."),
    ({"a.csv": "Feedback Id,Comment\nf1,ok\n", "b.csv": "Comment\nno id\n"},
     "Feedback export contains 1 blank Feedback Id value(s); refusing to dedupe an unstable snapshot."),
])
def test_rows_without_a_feedback_id_fail_the_run(tmp_path, files, message):
    store = LocalStore(tmp_path / "s")
    feedback.land(store, [SAMPLE], now=NOW)
    before = store.path(PARQUET).read_bytes()
    paths = [write(tmp_path / name, text) for name, text in files.items()]
    with pytest.raises(ValueError, match=re.escape(message)):
        feedback.land(store, paths, now=NOW)
    assert store.path(PARQUET).read_bytes() == before


def test_each_feedback_id_is_kept_once_as_the_ingester_picks_it(tmp_path):
    header = "Feedback Id,Date Submitted UTC,Comment,App,Platform,Browser\n"
    a = write(tmp_path / "a.csv", header +
              "f1,6/3/2025 9:00:00,newer,,,\n"            # f1: the later submission, though it has fewer values
              "f2,06/02/2025 10:00:00,more,Excel,Web,\n"  # f2: the same time, more values, though in the first file
              "f3,06/02/2025 10:00:00,in a,Word,,\n"      # f3: a full tie goes to the last file by name
              "f4,01/01/2020 00:00:00,dated,,,\n"         # f4: a dated row beats an undated one with more values
              "f5,06/02/2025 10:00:00,first,Word,,\n"     # f5: a tie in one file goes to the last row
              "f5,06/02/2025 10:00:00,second,Word,,\n")
    b = write(tmp_path / "b.csv", header +
              "f1,06/02/2025 10:00:00,older,Word,Web,Edge\n"
              "f2,06/02/2025 10:00:00,fewer,,,\n"
              "f3,06/02/2025 10:00:00,in b,Word,,\n"
              "f4,,undated,Word,Web,Edge\n")
    store = LocalStore(tmp_path / "s")
    out = feedback.land(store, [a, b], now=NOW)
    assert (out["rows"], out["duplicates"]) == (5, 5)
    _, rows = landed(store)
    # In file then row order.
    assert [(r["Feedback Id"], r["Comment"]) for r in rows] == [
        ("f1", "newer"), ("f2", "more"), ("f4", "dated"), ("f5", "second"), ("f3", "in b")]


@pytest.mark.parametrize("text", ["Feedback Id,Comment\n", "Feedback Id,Comment\n\n\n"])
def test_an_export_with_no_rows_never_empties_the_table(tmp_path, text):
    store = LocalStore(tmp_path / "s")
    empty = write(tmp_path / "empty.csv", text)
    with pytest.raises(ValueError, match=r"parsed 0 rows; refusing to write an empty snapshot"):
        feedback.land(store, [empty], now=NOW)
    assert store.list("raw/user_feedback") == []
    feedback.land(store, [SAMPLE], now=NOW)
    before = store.path(PARQUET).read_bytes()
    with pytest.raises(ValueError, match=r"parsed 0 rows; refusing to replace the existing user_feedback"):
        feedback.land(store, [empty], now=NOW)
    assert store.path(PARQUET).read_bytes() == before


def test_an_empty_file_is_skipped(tmp_path, caplog):
    caplog.set_level("INFO", logger="valuelens_jobs.collect.product_feedback")
    empty = write(tmp_path / "a-empty.csv", "")
    real = write(tmp_path / "b.csv", "Feedback Id,Comment\nf1,ok\n")
    store = LocalStore(tmp_path / "s")
    out = feedback.land(store, [empty, real], now=NOW)
    assert (out["files"], out["rows"]) == (2, 1)
    assert "a-empty.csv is empty; skipped" in caplog.text
    with pytest.raises(ValueError, match="missing 'Feedback Id'"):
        feedback.land(store, [empty], now=NOW)
    assert set(by_id(store)) == {"f1"}


def test_reads_exports_as_the_fabric_csv_reader_does(tmp_path):
    # A BOM, a padded and an empty header, a quoted line break and comma, a short row and a long row.
    csv = write(tmp_path / "a.csv", " Feedback Id ,Comment,App,\n"
                                    'f1,"Line one\nline two, with a comma",Word,x\n'
                                    "f2,Short\n"
                                    "f3,Long,Excel,extra,cut\n", bom=True)
    store = LocalStore(tmp_path / "s")
    assert feedback.land(store, [csv], now=NOW)["rows"] == 3
    rows = by_id(store)
    assert rows["f1"]["Comment"] == "Line one\nline two, with a comma" and rows["f1"]["_c3"] == "x"
    assert rows["f2"]["Comment"] == "Short" and rows["f2"]["App"] is None
    assert rows["f3"]["_c3"] == "extra" and "cut" not in rows["f3"].values()


def test_headers_too_long_for_a_sql_column_are_dropped(tmp_path, caplog):
    too_long, longest = "x" * 129, "y" * 128
    csv = write(tmp_path / "a.csv", f"Feedback Id,{too_long},{longest}\nf1,a,b\n")
    store = LocalStore(tmp_path / "s")
    assert feedback.land(store, [csv], now=NOW)["extras"] == 1
    columns, _ = landed(store)
    assert longest in columns and too_long not in columns
    assert "longer than 128 characters" in caplog.text


# ---------------------------------------------------------------- the drop folder
def test_collect_reads_every_export_in_landing(tmp_path):
    store = LocalStore(tmp_path)
    folder = tmp_path / "landing" / "product_feedback"
    # Unlike the ingester's '*feedback*', any name: exports add up, a later file by name wins a tie.
    june = write(folder / "b-june.csv", "Feedback Id,Comment\nf1,June\nf2,Both\n")
    may = write(folder / "a-may.CSV", "Feedback Id,Comment\nf0,May\nf2,Both (older file)\n")
    note = write(folder / "notes.txt", "Feedback Id\nf9\n")
    nested = write(folder / "archive" / "z.csv", "Feedback Id\nf8\n")
    out = feedback.collect_product_feedback(None, store, ON)
    assert (out["files"], out["rows"], out["duplicates"]) == (2, 3, 1)
    rows = by_id(store)
    assert set(rows) == {"f0", "f1", "f2"}
    assert (rows["f2"]["Comment"], rows["f2"]["SourceFile"], rows["f0"]["SourceFile"]) == (
        "Both", "b-june.csv", "a-may.CSV")
    assert all(p.exists() for p in (june, may, note, nested))  # the drop folder is never changed


def test_collect_reads_every_export_from_sharepoint(tmp_path):
    def unexpected():
        raise AssertionError("downloaded a file that isn't a CSV")

    routes = {
        f"{G}/sites/{SITE}": Resp(200, {"id": SITE}),
        f"{G}/drives/b!drive/root:/ValueLens/product_feedback:/children": Resp(200, {"value": [
            {"name": "feedback-2.csv", "id": "i2", "lastModifiedDateTime": "2026-09-30T08:00:00Z"},
            {"name": "feedback-1.csv", "id": "i1", "lastModifiedDateTime": "2026-09-01T08:00:00Z"},
            {"name": "readme.txt", "id": "t1", "lastModifiedDateTime": "2026-10-01T08:00:00Z"},
            {"name": "archive", "id": "f1", "folder": {}},
        ]}),
        f"{G}/drives/b!drive/items/i1/content": Resp(200, content=b"Feedback Id,Comment\nf1,First\n"),
        f"{G}/drives/b!drive/items/i2/content": Resp(200, content=b"\xef\xbb\xbfFeedback Id,Comment\nf2,Second\n"),
        f"{G}/drives/b!drive/items/t1/content": unexpected,
    }
    api, session = make_api(_sharepoint_handler(routes))  # GET only: the folder is never changed
    settings = Settings(modules=frozenset({"productFeedback"}), drop_site_id=SITE, drop_drive_id="b!drive",
                        drop_folder="ValueLens")
    store = LocalStore(tmp_path)
    out = feedback.collect_product_feedback(api, store, settings)
    assert (out["files"], out["rows"]) == (2, 2)
    rows = by_id(store)
    assert (rows["f1"]["Comment"], rows["f1"]["SourceFile"]) == ("First", "feedback-1.csv")
    assert (rows["f2"]["Comment"], rows["f2"]["SourceFile"]) == ("Second", "feedback-2.csv")
    assert not (tmp_path / "landing").exists()
    assert sum(1 for c in session.calls if c[1].endswith("/content")) == 2


def test_collect_from_adls_leaves_the_landing_container(tmp_path):
    uploaded = datetime(2026, 9, 30, 8, tzinfo=timezone.utc)
    service = FakeBlobService()
    service.blobs[("landing", "product_feedback/feedback.csv")] = (b"Feedback Id,Comment\nf1,Hi\n", uploaded)
    service.blobs[("landing", "product_feedback/more.csv")] = (b"Feedback Id,Comment\nf2,There\n", uploaded)
    service.blobs[("raw", "user_feedback/part-1.parquet")] = (b"stale", uploaded)
    store = AdlsStore("acct", root=tmp_path, service=service)
    out = feedback.collect_product_feedback(None, store, ON)
    assert (out["files"], out["rows"]) == (2, 2)
    assert {k for k in service.blobs if k[0] == "raw"} == {("raw", "user_feedback/part-0.parquet")}
    assert {k for k in service.blobs if k[0] == "landing"} == {
        ("landing", "product_feedback/feedback.csv"), ("landing", "product_feedback/more.csv")}
    assert set(by_id(store)) == {"f1", "f2"}


# ---------------------------------------------------------------- wiring, publish and V010
def test_collect_wiring_and_publish_targets(tmp_path, monkeypatch):
    from valuelens_jobs.collect import agent365, audit, graph, resource_graph

    called = []
    for mod, name in ((graph, "collect_licensed"), (audit, "collect_audit"), (agent365, "collect_agent365"),
                      (feedback, "collect_product_feedback"), (resource_graph, "collect_resource_graph")):
        monkeypatch.setattr(mod, name, lambda *a, _n=name, **k: called.append(_n))
    store = LocalStore(tmp_path)
    jobs_main.collect(store, Settings(modules=frozenset({"core", "productFeedback"})), api=object())
    assert called == ["collect_licensed", "collect_product_feedback", "collect_audit"]
    called.clear()
    jobs_main.collect(store, Settings(modules=frozenset({"core", "agent365", "productFeedback", "resourceGraph"})),
                      api=object())
    assert called == ["collect_licensed", "collect_agent365", "collect_product_feedback", "collect_resource_graph",
                      "collect_audit"]

    assert Settings.from_env({"VALUELENS_MODULES": "core,productFeedback"}).has("productFeedback")
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core", "productFeedback"}))) == [
        "curated", "licensed", "user_feedback"]
    assert jobs_main.publish_targets(Settings(modules=frozenset({"core", "agent365", "productFeedback"}))) == [
        "curated", "licensed", "agents_365", "user_feedback"]
    assert "user_feedback" not in jobs_main.publish_targets(Settings(modules=frozenset({"core"})))
    # Demo mode publishes only the sample, so the table keeps what it had.
    assert "user_feedback" not in jobs_main.publish_targets(
        Settings(modules=frozenset({"core", "productFeedback"}), sample_data=True))
    t = pub.TARGETS["user_feedback"]
    assert (t.table, t.prefix, t.partition, t.incremental) == ("user_feedback", "raw/user_feedback", None, False)


def _v010():
    sql = V010.read_text(encoding="utf-8")
    [(name, body)] = re.findall(r"CREATE TABLE dbo\.(\w+) \((.*?)\n\);", sql, re.S)
    return sql, name, re.findall(r"\[([^\]]+)\] ([A-Z0-9]+(?:\(\d+\))?) NULL", body)


def test_v010_creates_user_feedback_with_the_landed_columns(tmp_path):
    sql, name, columns = _v010()
    assert name == feedback.TABLE == pub.TARGETS["user_feedback"].table
    assert columns == [(c, pub.sql_type("DATE" if c == feedback.DATE_COLUMN else "VARCHAR"))
                       for c in (*feedback.COLUMNS, *feedback.LINEAGE)]
    store = LocalStore(tmp_path)
    feedback.land(store, [SAMPLE], now=NOW)
    rel = duckdb.sql(f"SELECT * FROM read_parquet('{store.path(PARQUET).as_posix()}')")
    assert [(c, pub.sql_type(str(t))) for c, t in zip(rel.columns, rel.types)] == columns
    assert "IF OBJECT_ID(N'dbo.user_feedback', N'U') IS NULL" in sql
    assert "WHERE version = 10)" in sql and "VALUES (10," in sql
    assert len(sql_mod.batches(sql)) == 2
    assert dict(sql_mod.migrations(V010.parent))[10] == V010


def test_publish_onto_the_v010_table_in_sqlite(tmp_path):
    _, name, columns = _v010()
    conn = sqlite3.connect(":memory:")
    conn.execute(f"CREATE TABLE [{name}] ({', '.join(f'[{c}] {t} NULL' for c, t in columns)})")
    store = LocalStore(tmp_path / "s")
    feedback.land(store, [SAMPLE], now=NOW)
    [result] = pub.publish(conn, store, ["user_feedback"])
    assert result == {"table": "user_feedback", "rows": 1215, "added_columns": []}
    row = conn.execute("SELECT [Feedback Type], [Sentiment], [Date Submitted Date], [SourceFile] "
                       "FROM user_feedback WHERE [Feedback Id] = ?", (FROWN,)).fetchone()
    assert row[:2] == ("Frown", "Negative") and str(row[2]).startswith("2025-06-02") and row[3] == SAMPLE.name

    # The next run replaces every row and adds an extra export column; text is cut to 4,000 characters.
    nxt = write(tmp_path / "next.csv", f"Feedback Id,Comment,Region\nf1,{'z' * 5000},EU\n")
    feedback.land(store, [nxt], now=NOW)
    [result] = pub.publish(conn, store, ["user_feedback"])
    assert result == {"table": "user_feedback", "rows": 1, "added_columns": ["Region"]}
    assert conn.execute("SELECT [Feedback Id], length([Comment]), [Region], [Sentiment] FROM user_feedback"
                        ).fetchall() == [("f1", pub.TEXT_LIMIT, "EU", None)]
