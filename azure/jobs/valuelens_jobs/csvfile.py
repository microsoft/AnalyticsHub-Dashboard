"""CSV exports read as the Fabric notebooks' Spark reader reads them: headers as sent, every value a
string, quoted commas and line breaks kept, short rows padded with nulls and long rows cut."""
from __future__ import annotations

import csv

from .tables import ident, q


def header(path) -> list[str]:
    """The column names without the BOM or surrounding spaces; an empty one is `_c<position>`, as in Spark."""
    with open(path, encoding="utf-8-sig", newline="") as fh:
        row = next(csv.reader(fh), None) or []
    return [(name or "").strip() or f"_c{i}" for i, name in enumerate(row)]


def load(con, path, table: str) -> list[str]:
    """Reads `path` into temp table `table` as string columns c0, c1, ... by position and returns
    the header. By position because DuckDB renames headers that differ only in case. No header,
    no table."""
    names = header(path)
    if names:
        columns = ", ".join(f"'c{i}': 'VARCHAR'" for i in range(len(names)))
        con.execute(f"CREATE OR REPLACE TEMP TABLE {ident(table)} AS SELECT * FROM read_csv({q(path)}, "
                    "header=true, auto_detect=false, delim=',', quote='\"', escape='\"', null_padding=true, "
                    f"strict_mode=false, parallel=false, skip=0, comment='', columns={{{columns}}})")
    return names
