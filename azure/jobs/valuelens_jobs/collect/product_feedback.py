"""Product feedback by CSV (module `productFeedback`): every `.csv` in the drop folder's
`product_feedback/` folder, landed as `raw/user_feedback/part-0.parquet` for the `user_feedback` table.

A port of the Fabric notebook `Copilot_ProductFeedback_Ingester`. The flow that saves the emailed
export (`Copilot_ProductFeedback_Email_to_OneLake`) is Fabric-only for now: on Azure you drop the
export in the folder yourself. Same rules as the ingester:

* Every export in the folder is read on every run and the rows are combined by column name, so
  exports add up. Each `Feedback Id` is kept once: the latest `Date Submitted UTC`, then the row with
  the most values, then the last file by name.
* Column names stay as exported. The 23 columns the model reads load blank when no export has them.
* `Sentiment` is Positive or Negative from `Feedback Type` (thumbs up or down, smile or frown, ...),
  and `Date Submitted Date` is the date of `Date Submitted UTC`.
* `SourceFile` (the export's name) and `LoadDate` (when the run loaded it, in UTC) are on every row.
* A missing or blank `Feedback Id` fails the run rather than writing rows that can't be deduplicated.

Unlike the ingester, every CSV is read whatever its name (the ingester reads `*feedback*` only),
headers are read without surrounding spaces, and column names match ignoring case. With no CSV the
table is left as it is; exports with no rows fail instead of emptying it.
"""
from __future__ import annotations

import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from .. import csvfile
from ..dropfolder import open_dropfolder
from ..tables import ident, q

log = logging.getLogger("valuelens_jobs.collect.product_feedback")

SUBDIR = "product_feedback"
TABLE = "user_feedback"
PREFIX = f"raw/{TABLE}"
ID_COLUMN = "Feedback Id"
TYPE_COLUMN = "Feedback Type"
SUBMITTED_COLUMN = "Date Submitted UTC"
DATE_COLUMN = "Date Submitted Date"
SENTIMENT_COLUMN = "Sentiment"
LINEAGE = ("SourceFile", "LoadDate")
# The columns the model's ProductFeedback query reads: the ingester's EMPTY_SCHEMA, 21 from the export
# and the two derived ones (tests/test_azure_product_feedback.py keeps them in step).
COLUMNS = [
    "Feedback Id", "Comment", "Translated Comment", "Comment Language", "Date Submitted UTC",
    "Feedback Type", "Microsoft Response Status", "App", "App Language", "Platform", "Source Type",
    "Logs, Attachments", "User Id", "User Email", "Browser", "Browser Version", "AI Context Prompt",
    "AI Context Response Message", "Survey Question", "Survey Response Option", "Additional Metadata",
    DATE_COLUMN, SENTIMENT_COLUMN,
]
DERIVED = (DATE_COLUMN, SENTIMENT_COLUMN)
POSITIVE = ["thumbs up", "smile", "like", "compliment", "positive"]
NEGATIVE = ["thumbs down", "frown", "dislike", "complaint", "negative"]
# Azure SQL column names are at most 128 characters; a longer export header can't be published.
MAX_COLUMN_NAME = 128


def _lit(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def submitted_sql(expr: str) -> str:
    """`Date Submitted UTC` as a timestamp in UTC, through the ingester's formats in its order; NULL
    when none fits. DuckDB's %m, %d and %H also read one digit, so the first format covers the
    ingester's 'M/d/yyyy H:mm:ss' too."""
    return (f"coalesce(try_strptime({expr}, '%m/%d/%Y %H:%M:%S'), try_strptime({expr}, '%Y-%m-%d %H:%M:%S'), "
            f"TRY_CAST(TRY_CAST({expr} AS TIMESTAMPTZ) AS TIMESTAMP))")


def sentiment_sql(expr: str) -> str:
    """The ingester's `Sentiment`: Positive or Negative from `Feedback Type`, otherwise blank."""
    kind = f"lower(trim({expr}))"
    return (f"CASE WHEN {kind} IN ({', '.join(map(_lit, POSITIVE))}) THEN 'Positive' "
            f"WHEN {kind} IN ({', '.join(map(_lit, NEGATIVE))}) THEN 'Negative' END")


def safe_header(header) -> list[str]:
    """Column names as Fabric's Spark reader makes them (case-insensitive): a name that repeats,
    ignoring case, gets its position appended every time it appears. Then a name the table knows,
    matched ignoring case, takes the table's spelling ('feedback id' is 'Feedback Id')."""
    lowered = [h.lower() for h in header]
    names = [f"{h}{i}" if lowered.count(h.lower()) > 1 else h for i, h in enumerate(header)]
    known = {c.lower(): c for c in (*COLUMNS, *LINEAGE)}
    names = [known.get(n.lower(), n) for n in names]
    lowered = [n.lower() for n in names]
    clashes = sorted({n for n in names if lowered.count(n.lower()) > 1})
    if clashes:
        raise ValueError(f"Ambiguous source headers after numbering repeats: {clashes}")
    return names


def _column(out: str, name: str, positions: dict, stamp: str) -> str:
    """One file's SQL for output column `out`: the derived columns, the lineage, else the export's own."""
    have = {low: f"c{i}" for low, i in positions.items()}
    own = have.get(out.lower())
    if out == SENTIMENT_COLUMN and TYPE_COLUMN.lower() in have:
        return sentiment_sql(have[TYPE_COLUMN.lower()])
    if out == DATE_COLUMN:
        if SUBMITTED_COLUMN.lower() in have:
            return f"CAST({submitted_sql(have[SUBMITTED_COLUMN.lower()])} AS DATE)"
        if own:
            return f"coalesce(TRY_CAST({own} AS DATE), CAST({submitted_sql(own)} AS DATE))"
        return "CAST(NULL AS DATE)"
    if out == "SourceFile":
        return _lit(name)
    if out == "LoadDate":
        return _lit(stamp)
    return own or "CAST(NULL AS VARCHAR)"


def land(store, files, *, now: datetime | None = None) -> dict:
    """Lands product feedback exports (local CSVs: paths, or `(name, path)` pairs, in name order) as
    the `user_feedback` snapshot in `store`."""
    files = [f if isinstance(f, tuple) else (Path(f).name, f) for f in files]
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    existing = store.list(PREFIX)
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone = 'UTC'")
        sources, seen, too_long = [], {}, set()
        for k, (name, path) in enumerate(files):
            header = csvfile.load(con, path, f"f{k}")
            if not header:
                log.info("product_feedback: %s is empty; skipped", name)
                continue
            try:
                names = safe_header(header)
            except ValueError as exc:
                raise ValueError(f"Product feedback CSV {name}: {exc}") from None
            positions = {}
            for i, column in enumerate(names):
                if len(column) > MAX_COLUMN_NAME:
                    too_long.add(column)
                    continue
                positions[column.lower()] = i
                seen.setdefault(column.lower(), column)  # the first file's spelling wins
            count = con.execute(f"SELECT count(*) FROM f{k}").fetchone()[0]
            log.info("product_feedback: %s: %s row(s)", name, count)
            sources.append((k, name, positions))

        if not any(ID_COLUMN.lower() in positions for _, _, positions in sources):
            raise ValueError("Feedback export is missing 'Feedback Id'; refusing to write an unstable snapshot.")
        known = {c.lower() for c in (*COLUMNS, *LINEAGE)}
        extras = [column for low, column in seen.items() if low not in known]
        output = [*COLUMNS, *extras, *LINEAGE]
        # Positional names (o0, o1, ...) until the final write, so no export header can clash with the
        # helper columns.
        selects = [
            "SELECT " + ", ".join(f"{_column(out, name, positions, stamp)} AS o{j}" for j, out in enumerate(output))
            + f", {k} AS vl_file, rowid AS vl_row FROM f{k}"
            for k, name, positions in sources
        ]
        con.execute("CREATE TEMP TABLE combined AS " + " UNION ALL ".join(selects))
        o = {column: f"o{j}" for j, column in enumerate(output)}
        feedback_id = o[ID_COLUMN]
        blank = con.execute(f"SELECT count(*) FROM combined WHERE {feedback_id} IS NULL "
                            f"OR trim({feedback_id}) = ''").fetchone()[0]
        if blank:
            raise ValueError(f"Feedback export contains {blank:,} blank Feedback Id value(s); "
                             "refusing to dedupe an unstable snapshot.")

        # The ingester's order: latest submission, most values, last file by name. Then the last row.
        score = " + ".join(f"(CASE WHEN {o[c]} IS NOT NULL AND trim(CAST({o[c]} AS VARCHAR)) <> '' THEN 1 ELSE 0 END)"
                           for c in output if c != ID_COLUMN)
        con.execute(f"CREATE TEMP TABLE kept AS SELECT * EXCLUDE (vl_rank) FROM (SELECT *, row_number() OVER ("
                    f"PARTITION BY {feedback_id} ORDER BY {submitted_sql(o[SUBMITTED_COLUMN])} DESC NULLS LAST, "
                    f"{score} DESC, {o['SourceFile']} DESC NULLS LAST, vl_file DESC, vl_row DESC) AS vl_rank "
                    "FROM combined) WHERE vl_rank = 1")
        total = con.execute("SELECT count(*) FROM combined").fetchone()[0]
        rows = con.execute("SELECT count(*) FROM kept").fetchone()[0]
        if rows == 0:
            if existing:
                raise ValueError(f"Feedback export parsed 0 rows; refusing to replace the existing {TABLE}.")
            raise ValueError("Feedback export parsed 0 rows; refusing to write an empty snapshot.")

        rel = f"{PREFIX}/part-0.parquet"
        target = store.path(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        select = ", ".join(f"{o[c]} AS {ident(c)}" for c in output)
        con.execute(f"COPY (SELECT {select} FROM kept ORDER BY vl_file, vl_row) TO {q(tmp)} (FORMAT PARQUET)")
        split = dict(con.execute(f"SELECT {o[SENTIMENT_COLUMN]}, count(*) FROM kept GROUP BY 1").fetchall())
    finally:
        con.close()
    tmp.replace(target)
    store.push([rel])
    stale = [r for r in store.list(PREFIX) if r != rel]
    if stale:
        store.remove(stale)

    missing = [c for c in COLUMNS if c not in DERIVED and c.lower() not in seen]
    positive, negative = split.get("Positive", 0), split.get("Negative", 0)
    log.info("product_feedback: wrote %s: %s file(s), %s rows, %s duplicate(s) removed by Feedback Id, "
             "%s columns (%s extra kept)", TABLE, len(files), rows, total - rows, len(output), len(extras))
    log.info("product_feedback: sentiment %s positive, %s negative, %s neither", positive, negative,
             rows - positive - negative)
    if missing:
        log.warning("product_feedback: not in any export, loaded blank: %s", ", ".join(missing))
    if too_long:
        log.warning("product_feedback: headers longer than %s characters can't be SQL columns, dropped: %s",
                    MAX_COLUMN_NAME, ", ".join(repr(h) for h in sorted(too_long)))
    return {"files": len(files), "rows": rows, "duplicates": total - rows, "columns": len(output),
            "extras": len(extras), "missing": missing, "positive": positive, "negative": negative}


def collect_product_feedback(api, store, settings, *, drop=None) -> dict:
    drop = drop or open_dropfolder(store, settings, api)
    names = sorted(n for n, _ in drop.list(SUBDIR) if n.lower().endswith(".csv"))
    if not names:
        log.info("product_feedback: no CSV in the drop folder's %s/ folder; %s left as it is", SUBDIR, TABLE)
        return {"files": 0}
    with tempfile.TemporaryDirectory(prefix="valuelens-feedback-") as tmp:
        files = []
        for k, name in enumerate(names):
            path = Path(tmp) / f"{k}.csv"
            path.write_bytes(drop.read_bytes(SUBDIR, name))
            files.append((name, path))
        return land(store, files)
