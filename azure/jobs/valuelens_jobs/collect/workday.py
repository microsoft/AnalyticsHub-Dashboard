"""Workday org data by CSV (data source `workday`): the newest export in the drop folder's `workday/`
folder, through the rules of the Fabric notebook `Copilot_Org_Data_Workday_Lander`.

The logic is `valuelens_core.workday`, the notebook's rules unchanged. With Entra ID org data in
`raw/copilot_org_data`, the export adds the columns that data doesn't have, matched on the work email;
Entra ID's people and values always win, and Workday-only people are left out. Without it, AUTO lands
the export on its own. VALUELENS_WORKDAY_OUTPUT_TABLE says where the result goes:

* `dbo.copilot_org_data_workday_preview` (the default, as in the notebook): its own table to review,
  `raw/copilot_org_data_workday_preview`. The report keeps reading `dbo.copilot_org_data`.
* `dbo.copilot_org_data`, with VALUELENS_WORKDAY_ALLOW_BASE_OVERWRITE=true (what the installer
  deploys, as on Fabric): the org data itself, enriched in place after each Entra ID load. If that load
  fails, the last enriched org data is the baseline, so its Workday columns keep their values.

Deliberate differences from the notebook:

* Only the newest export (by modified time, then name) is read; older files stay in the folder,
  ignored. The notebook combines every file in `Files/org_workday`, where the Fabric installer keeps
  one, and two exports of the same people would conflict.
* A file that isn't UTF-8 fails with a message saying so, where Spark would replace what it can't read.
* Columns with names over 128 characters (Azure SQL's limit) are dropped, with a warning.

With no export, nothing is written: the org data stays as the Entra ID load left it.
"""
from __future__ import annotations

import logging
import re

import duckdb

from valuelens_core import workday

from ..dropfolder import open_dropfolder
from ..tables import ident, parquet_glob
from .agent365 import _modified
from .graph import _replace_snapshot

log = logging.getLogger("valuelens_jobs.collect.workday")

SUBDIR = "workday"
EXTENSIONS = (".csv", ".txt")
BASE_PREFIX = "raw/copilot_org_data"
PREVIEW_PREFIX = "raw/copilot_org_data_workday_preview"
# Azure SQL column names are at most 128 characters; a longer export header can't be published.
MAX_COLUMN_NAME = 128
# The core's messages name the notebook's settings; on Azure they're environment variables.
ENV_NAMES = {
    "MODE": "VALUELENS_WORKDAY_MODE",
    "OUTPUT_TABLE": "VALUELENS_WORKDAY_OUTPUT_TABLE",
    "ALLOW_BASE_OVERWRITE": "VALUELENS_WORKDAY_ALLOW_BASE_OVERWRITE",
    "MIN_WORKDAY_MATCH_RATE": "VALUELENS_WORKDAY_MIN_MATCH_RATE",
    "WORKDAY_EMAIL_COLUMN": "VALUELENS_WORKDAY_EMAIL_COLUMN",
    "BASE_TABLE": workday.BASE_TABLE,
}
_SETTING = re.compile(r"\b(" + "|".join(ENV_NAMES) + r")\b")


def output_table(settings) -> str:
    return settings.workday_output_table or workday.PREVIEW_TABLE


def writes_preview(settings) -> bool:
    """Whether the collector writes the review table rather than the org data itself."""
    return output_table(settings).casefold() == workday.PREVIEW_TABLE.casefold()


def config(settings) -> workday.Config:
    raw = settings.workday_min_match_rate
    try:
        rate = float(raw) if raw else workday.DEFAULT_MIN_MATCH_RATE
    except ValueError:
        raise ValueError(f"VALUELENS_WORKDAY_MIN_MATCH_RATE must be a number from 0 to 1, got {raw!r}.") from None
    return workday.Config(
        mode=settings.workday_mode or "auto",
        output_table=output_table(settings),
        email_column=settings.workday_email_column or workday.DEFAULT_EMAIL_COLUMN,
        min_match_rate=rate,
        allow_base_overwrite=settings.workday_allow_base_overwrite,
    )


def _azure_names(exc: ValueError) -> ValueError:
    return ValueError(_SETTING.sub(lambda m: ENV_NAMES[m.group(1)], str(exc)))


def _prefix(table: str) -> str:
    if table.casefold() == workday.BASE_TABLE.casefold():
        return BASE_PREFIX
    if table.casefold() == workday.PREVIEW_TABLE.casefold():
        return PREVIEW_PREFIX
    raise ValueError(f"VALUELENS_WORKDAY_OUTPUT_TABLE must be {workday.PREVIEW_TABLE} (the default, to review) "
                     f"or {workday.BASE_TABLE}, got {table!r}.")


def read_base(store):
    """The Entra ID org data as (columns, rows), every value a string, or None when there's none yet."""
    store.pull(BASE_PREFIX)
    src = parquet_glob(store.root, BASE_PREFIX)
    if not src:
        return None
    con = duckdb.connect()
    try:
        con.execute(f"CREATE TEMP VIEW base AS SELECT * FROM {src}")
        columns = [r[0] for r in con.execute("DESCRIBE base").fetchall()]
        select = ", ".join(f"CAST({ident(c)} AS VARCHAR)" for c in columns)
        rows = con.execute(f"SELECT {select} FROM base").fetchall()
    finally:
        con.close()
    return columns, rows


def _summary(diagnostics: dict) -> str:
    parts = []
    for key, value in diagnostics.items():
        if key == "match_rate" and value is not None:
            value = f"{value:.1%}"
        parts.append(f"{key}={value}")
    return ", ".join(parts)


def collect_workday(api, store, settings, *, drop=None) -> dict:
    cfg = config(settings)
    try:
        workday.validate_config(cfg)
    except ValueError as exc:
        raise _azure_names(exc) from exc
    prefix = _prefix(cfg.output_table)
    drop = drop or open_dropfolder(store, settings, api)
    files = [(n, s) for n, s in drop.list(SUBDIR) if n.lower().endswith(EXTENSIONS)]
    if not files:
        log.info("workday: no export in the drop folder's %s/ folder. %s", SUBDIR, workday.NO_EXPORT)
        return {"file": None}
    name = max(files, key=lambda f: (_modified(f[1]), f[0]))[0]
    if len(files) > 1:
        log.info("workday: reading the newest export, %s; %s older file(s) ignored", name, len(files) - 1)
    columns, rows = workday.read_csv([(name, drop.read_bytes(SUBDIR, name))])
    try:
        out_columns, out_rows, diagnostics = workday.prepare(cfg, columns, rows, lambda: read_base(store))
    except ValueError as exc:
        raise _azure_names(exc) from exc
    too_long = [c for c in out_columns if len(c) > MAX_COLUMN_NAME]
    if too_long:
        log.warning("workday: headers longer than %s characters can't be SQL columns, dropped: %s",
                    MAX_COLUMN_NAME, ", ".join(repr(c) for c in too_long))
        keep = [i for i, c in enumerate(out_columns) if len(c) <= MAX_COLUMN_NAME]
        out_columns = [out_columns[i] for i in keep]
        out_rows = [[row[i] for i in keep] for row in out_rows]
    count = _replace_snapshot(store, prefix, out_columns, out_rows)
    log.info("workday: wrote %s rows and %s columns to %s from %s; %s", count, len(out_columns), prefix, name,
             _summary(diagnostics))
    return {"file": name, "table": cfg.output_table, "columns": len(out_columns), **diagnostics}
