"""Agent 365 registry by CSV (module `agent365`): the newest `.csv` in the drop folder's `agent365/`
folder, landed as `raw/agents_365/part-0.parquet` for the `agents_365` table.

A port of the Fabric notebook `Copilot_Agent365_Lander` (the CSV route). The Graph API route, the
`Copilot_Agent365_Registry_Ingester` notebook, is Fabric-only for now. Same rules as the Lander:

* Every source column is kept as exported. The 37 canonical columns the model reads are added as
  copies, never renames, matched ignoring case, spaces and punctuation, through the same aliases.
* Headers that collide once normalised are kept once when their values are identical (the
  canonical spelling wins), and fail the run when they differ.
* A `Date created` or `Last Activity Date` before 2000 (Agent 365's 0001-01-01 for "no date")
  loads blank: the `valuelens_core.dates` rule, in SQL as in the Lander.
* `Snapshot As Of` is the latest `Last updated`, on every row.

Each upload replaces the last: the table is the newest export (by modified time, then name), not a
merge. With no CSV the table is left as it is; an export with no rows fails instead of emptying it.
"""
from __future__ import annotations

import logging
import re
import tempfile
from datetime import datetime
from pathlib import Path

import duckdb

from valuelens_core.dates import MIN_PLAUSIBLE_YEAR

from .. import csvfile
from ..dropfolder import open_dropfolder
from ..tables import ident, q

log = logging.getLogger("valuelens_jobs.collect.agent365")

SUBDIR = "agent365"
TABLE = "agents_365"
PREFIX = f"raw/{TABLE}"
SNAPSHOT_COLUMN = "Snapshot As Of"
# 'Last updated' stays as sent, as in the Lander.
DATE_COLUMNS = ("Date created", "Last Activity Date")
# valuelens_core.dates.YEAR_PATTERN without the look-arounds DuckDB's regex engine (RE2) lacks: the
# first run of exactly four digits.
YEAR_SQL_PATTERN = r"(?:^|[^0-9])([0-9]{4})(?:[^0-9]|$)"
# Azure SQL column names are at most 128 characters; a longer export header can't be published.
MAX_COLUMN_NAME = 128

CANONICAL = [
    "Agent name", "Supported in", "Date created", "Agent creator", "Publisher",
    "Agent type (A365)", "Version", "Availability", "Agent creator ID",
    "Agent description", "Created in", "Last updated", "Custom actions",
    "Title ID", "Sensitivity",
    "Can read OneDrive and Sharepoint items", "OneDrive and Sharepoint items",
    "Can read OneDrive files", "OneDrive files", "OneDrive sites",
    "Can read Sharepoint sites and files", "Sharepoint files", "Sharepoint sites",
    "Can extend to Graph connector", "Graph connector details",
    "Can generate images using user prompt", "Can use code interpreter",
    "Contains uploaded files", "Uploaded files", "Status",
    "Active Users", "Total sessions", "Exception rate", "Last Activity Date",
    "Deployment", "Run Time", "Risks",
]
# Each canonical column takes the first alias found in the export (tests/test_azure_agent365.py
# keeps this in step with the Lander's alias plan).
ALIASES = {
    "Agent name": ["Agent name", "Name", "Agent", "Display name", "DisplayName"],
    "Supported in": ["Supported in", "Supported clients", "Supported hosts", "Channel", "Channels",
                     "Supported platforms"],
    "Date created": ["Date created", "Created date", "Created on", "Created", "CreatedDateTime"],
    "Agent creator": ["Agent creator", "Owner", "Created by", "Developer Name", "Publisher", "Publisher name"],
    "Publisher": ["Publisher", "Publisher name", "Developer", "Developer Name", "Company"],
    "Agent type (A365)": ["Agent type (A365)", "Agent type", "Publisher Type", "Type", "Package type"],
    "Version": ["Version", "Agent version", "Package version"],
    "Availability": ["Availability", "Available to", "Availability status"],
    "Agent creator ID": ["Agent creator ID", "Creator Id", "Creator ID", "Owner Id", "Owner ID", "Created by id",
                         "Created by ID"],
    "Agent description": ["Agent description", "Description", "Short description", "Summary", "Long description"],
    "Created in": ["Created in", "Platform", "Source", "Created via"],
    "Last updated": ["Last updated", "Last Modified", "Last modified", "Modified date", "LastModifiedDateTime"],
    "Custom actions": ["Custom actions", "Custom action", "Commands", "Actions", "Action titles"],
    "Title ID": ["Title ID", "Title Id", "TitleId", "title_id", "Package ID", "Package Id", "PackageID"],
    "Sensitivity": ["Sensitivity", "Sensitivity label", "SensitivityLabel"],
    "Can read OneDrive and Sharepoint items": [
        "Can read OneDrive and Sharepoint items",
        "Can read OneDrive and SharePoint items",
        "Read OneDrive and SharePoint items",
    ],
    "OneDrive and Sharepoint items": [
        "OneDrive and Sharepoint items",
        "OneDrive and SharePoint items",
        "SharePoint items",
    ],
    "Can read OneDrive files": ["Can read OneDrive files", "Read OneDrive files"],
    "OneDrive files": ["OneDrive files", "OneDrive file list"],
    "OneDrive sites": ["OneDrive sites", "OneDrive site list"],
    "Can read Sharepoint sites and files": [
        "Can read Sharepoint sites and files",
        "Can read SharePoint sites and files",
        "Read SharePoint sites and files",
    ],
    "Sharepoint files": ["Sharepoint files", "SharePoint files"],
    "Sharepoint sites": ["Sharepoint sites", "SharePoint sites"],
    "Can extend to Graph connector": ["Can extend to Graph connector", "Can extend to Graph connectors",
                                      "Graph connector access"],
    "Graph connector details": ["Graph connector details", "Graph connector detail", "Graph connectors",
                                "Connector details"],
    "Can generate images using user prompt": ["Can generate images using user prompt", "Generate images",
                                              "Image generation"],
    "Can use code interpreter": ["Can use code interpreter", "Use code interpreter", "Code interpreter"],
    "Contains uploaded files": ["Contains uploaded files", "Uploaded files present", "Has uploaded files"],
    "Uploaded files": ["Uploaded files", "Uploaded file list"],
    "Status": ["Status", "Deployment status"],
    "Active Users": ["Active Users", "Active users", "Users", "Monthly active users"],
    "Total sessions": ["Total sessions", "Sessions", "Session count"],
    "Exception rate": ["Exception rate", "Error rate"],
    "Last Activity Date": ["Last Activity Date", "Last used", "Last activity", "Last seen", "Last used date"],
    "Deployment": ["Deployment", "Deployed to", "Published to"],
    "Run Time": ["Run Time", "Runtime", "Run time", "Total runtime", "Total Run Time"],
    "Risks": ["Risks", "Risk", "Risk summary"],
}


def norm(value) -> str:
    """A header compared ignoring case, spaces and punctuation ('Creator ID' == 'creator_id')."""
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _distinct(con, a: int, b: int) -> bool:
    return bool(con.execute(f"SELECT count(*) FROM src WHERE c{a} IS DISTINCT FROM c{b}").fetchone()[0])


def dedupe(con, header) -> tuple[list[int], list[tuple[str, list[str]]]]:
    """Positions of the source columns kept once headers that collide after `norm` are collapsed,
    and what was collapsed. Colliding columns must hold the same values."""
    groups: dict[str, list[int]] = {}
    for i, name in enumerate(header):
        groups.setdefault(norm(name), []).append(i)
    canonical = {norm(c): c for c in CANONICAL}
    dropped, collapsed = set(), []
    for positions in groups.values():
        if len(positions) == 1:
            continue
        if any(_distinct(con, positions[0], other) for other in positions[1:]):
            raise ValueError(f"Ambiguous source headers after normalization: {[header[i] for i in positions]}")
        keep = next((i for i in positions if canonical.get(norm(header[i])) == header[i]), positions[0])
        dropped.update(i for i in positions if i != keep)
        collapsed.append((header[keep], [header[i] for i in positions if i != keep]))
    return [i for i in range(len(header)) if i not in dropped], collapsed


def resolve(header, keep) -> dict[str, int]:
    """{canonical column: source position} for every canonical column found in the export."""
    lookup = {norm(header[i]): i for i in keep}
    out = {}
    for target in CANONICAL:
        for alias in ALIASES[target]:
            hit = lookup.get(norm(alias))
            if hit is not None:
                out[target] = hit
                break
    return out


def _blank_implausible_dates(con) -> int:
    """Blanks each DATE_COLUMNS value in `landed` whose year is before MIN_PLAUSIBLE_YEAR; returns how many."""
    blanked = 0
    for column in DATE_COLUMNS:
        c = ident(column)
        implausible = f"TRY_CAST(regexp_extract({c}, '{YEAR_SQL_PATTERN}', 1) AS INTEGER) < {MIN_PLAUSIBLE_YEAR}"
        blanked += con.execute(f"SELECT count(*) FROM landed WHERE {implausible}").fetchone()[0]
        con.execute(f"UPDATE landed SET {c} = NULL WHERE {implausible}")
    return blanked


def land(store, path, *, name: str | None = None) -> dict:
    """Lands one Agent 365 export (a local CSV) as the `agents_365` snapshot in `store`."""
    name = name or Path(path).name
    existing = store.list(PREFIX)
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone = 'UTC'")
        header = csvfile.load(con, path, "src")
        rows = con.execute("SELECT count(*) FROM src").fetchone()[0] if header else 0
        if rows == 0:
            if existing:
                raise ValueError(f"Agent 365 CSV {name} parsed 0 rows; refusing to replace the existing {TABLE}.")
            raise ValueError(f"Agent 365 CSV {name} parsed 0 rows; refusing to write an empty snapshot.")

        keep, collapsed = dedupe(con, header)
        resolved = resolve(header, keep)
        canonical = {c.casefold() for c in CANONICAL} | {SNAPSHOT_COLUMN.casefold()}
        extras = [i for i in keep if header[i].casefold() not in canonical]
        too_long = [header[i] for i in extras if len(header[i]) > MAX_COLUMN_NAME]
        extras = [i for i in extras if len(header[i]) <= MAX_COLUMN_NAME]
        select = [f"c{resolved[t]} AS {ident(t)}" if t in resolved else f"CAST(NULL AS VARCHAR) AS {ident(t)}"
                  for t in CANONICAL]
        select += [f"c{i} AS {ident(header[i])}" for i in extras]
        con.execute(f"CREATE TEMP TABLE landed AS SELECT {', '.join(select)} FROM src")
        blanked = _blank_implausible_dates(con)
        con.execute(f"CREATE TEMP TABLE snapshot AS SELECT *, (SELECT max(TRY_CAST(TRY_CAST(\"Last updated\" "
                    f"AS TIMESTAMPTZ) AS TIMESTAMP)) FROM landed) AS {ident(SNAPSHOT_COLUMN)} FROM landed")
        as_of = con.execute(f"SELECT max({ident(SNAPSHOT_COLUMN)}) FROM snapshot").fetchone()[0]

        rel = f"{PREFIX}/part-0.parquet"
        target = store.path(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        con.execute(f"COPY (SELECT * FROM snapshot) TO {q(tmp)} (FORMAT PARQUET)")
        columns = len(con.execute("SELECT * FROM snapshot LIMIT 0").description)
    finally:
        con.close()
    tmp.replace(target)
    store.push([rel])
    stale = [r for r in store.list(PREFIX) if r != rel]
    if stale:
        store.remove(stale)

    exact = [t for t, i in resolved.items() if header[i] == t]
    via_alias = [(t, header[i]) for t, i in resolved.items() if header[i] != t]
    missing = [t for t in CANONICAL if t not in resolved]
    log.info("agent365: %s, schema match: %s exact, %s via alias, %s not found (loaded blank), %s extra kept",
             name, len(exact), len(via_alias), len(missing), len(extras))
    for target_name, source in via_alias:
        log.info("  %r <- %r", target_name, source)
    for kept, dropped in collapsed:
        log.info("  %r kept; dropped equivalent %r", kept, dropped)
    if missing:
        log.warning("agent365: not in the export, loaded blank: %s", ", ".join(missing))
    if too_long:
        log.warning("agent365: headers longer than %s characters can't be SQL columns, dropped: %s",
                    MAX_COLUMN_NAME, ", ".join(repr(h) for h in too_long))
    if blanked:
        log.info("agent365: %s date(s) before %s loaded blank", blanked, MIN_PLAUSIBLE_YEAR)
    log.info("agent365: wrote %s: %s rows, %s columns, snapshot as of %s", TABLE, rows, columns, as_of)
    return {"file": name, "rows": rows, "columns": columns, "via_alias": len(via_alias), "missing": missing,
            "extras": len(extras), "dates_blanked": blanked, "snapshot_as_of": as_of.isoformat() if as_of else None}


def _modified(stamp) -> float:
    """A drop folder file's modified time (a POSIX time from storage, ISO 8601 from SharePoint)."""
    if stamp is None:
        return 0.0
    try:
        return float(stamp)
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def newest(files) -> str | None:
    """The most recently modified CSV in `[(name, modified)]`, then the last by name."""
    csvs = [(n, s) for n, s in files if n.lower().endswith(".csv")]
    if not csvs:
        return None
    return max(csvs, key=lambda f: (_modified(f[1]), f[0]))[0]


def collect_agent365(api, store, settings, *, drop=None) -> dict:
    drop = drop or open_dropfolder(store, settings, api)
    files = drop.list(SUBDIR)
    name = newest(files)
    if name is None:
        log.info("agent365: no CSV in the drop folder's %s/ folder; %s left as it is", SUBDIR, TABLE)
        return {"file": None}
    ignored = sum(1 for n, _ in files if n.lower().endswith(".csv")) - 1
    if ignored:
        log.info("agent365: reading the newest export, %s; %s older CSV(s) ignored", name, ignored)
    with tempfile.TemporaryDirectory(prefix="valuelens-agent365-") as tmp:
        path = Path(tmp) / "agents.csv"
        path.write_bytes(drop.read_bytes(SUBDIR, name))
        return land(store, path, name=name)
