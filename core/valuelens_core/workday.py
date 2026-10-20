"""Workday org data: port of Copilot_Org_Data_Workday_Lander.ipynb (pure Python).

Two modes, as in the notebook:

* Enrich: the Entra ID org data (`copilot_org_data`) gains every Workday column it doesn't already
  have, matched on the work email (trimmed and lowercased on both sides). Entra ID is authoritative:
  no baseline person, column or value changes, even a blank one, and Workday-only people are counted
  but left out.
* Standalone: without Entra ID org data, the export becomes an email-keyed org table on its own.

AUTO enriches when the baseline exists and lands standalone only when it doesn't. Every check runs
before anything is written. Values stay strings (or None) and are never trimmed, and the messages are
the notebook's, setting names included.
"""
from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import dataclass

BASE_TABLE = 'dbo.copilot_org_data'
PREVIEW_TABLE = 'dbo.copilot_org_data_workday_preview'
MODES = ('auto', 'enrich', 'standalone')
DEFAULT_EMAIL_COLUMN = 'primaryWorkEmail'
DEFAULT_MIN_MATCH_RATE = 0.5
NO_EXPORT = 'No Workday export found. No write performed; any existing output is unchanged.'
METADATA = ('PersonId_Normalized', 'TotalEmployees', 'OrgData_Source')
ENRICH_SOURCE = 'entra+workday:additive'
STANDALONE_SOURCE = 'workday:standalone'
GRAPH_FIELDS = ['displayName', 'companyName', 'managerUPN', 'accountEnabled', 'OrgLevel', 'HierarchyPath',
                'TopOfChain_Name', 'IsManager', 'DirectReports', 'HierarchyError', 'OrgPath',
                *[f'Level{i}_Name' for i in range(15)]]
CANONICAL = GRAPH_FIELDS + [
    'PersonId', 'id', 'Job_Profile', 'Job_Family', 'Job_Family_Group', 'Persona', 'Compensation_Grade',
    'Worker_Type', 'Worker_SubType', 'On_Leave', 'IsOnLeave', 'country', 'sub_Country', 'Organization',
    'JobTitle', 'Function', 'officeLocation', 'Location', 'city',
]
# Standalone only, in this order: a missing field copies the first candidate present, which can be a
# field added earlier in the list. An existing field is never overwritten.
ALIASES = {
    'Job_Profile': ['Job Profile', 'Job Title', 'JobTitle', 'Business Title', 'Position'],
    'Job_Family': ['Job Family'],
    'Job_Family_Group': ['Job Family Group'],
    'Persona': ['Worker Persona'],
    'Compensation_Grade': ['Compensation Grade', 'Grade', 'Pay Grade'],
    'Worker_Type': ['Worker Type', 'Employee Type'],
    'Worker_SubType': ['Worker Sub Type', 'Worker Subtype', 'Employee Sub Type'],
    'On_Leave': ['On Leave', 'Leave of Absence', 'OnLeave'],
    'country': ['Location Country', 'Country/Region'],
    'sub_Country': ['Sub Country', 'Sub-Country', 'Region', 'State', 'Province'],
    'Organization': ['Job_Family_Group'],
    'JobTitle': ['Job_Profile'],
    'Function': ['Job_Family_Group'],
    'officeLocation': ['sub_Country'],
    'Location': ['sub_Country'],
    'city': ['sub_Country'],
}
_ON_LEAVE = ('1', 'true', 'yes', 'y')
_INVALID = re.compile(r'[ ,;{}()\r\n\t=]')
_TABLE = re.compile(r'[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*')


@dataclass(frozen=True)
class Config:
    """The notebook's settings (MODE, BASE_TABLE, OUTPUT_TABLE, WORKDAY_EMAIL_COLUMN,
    INCLUDE_UNMATCHED_WORKDAY, MIN_WORKDAY_MATCH_RATE, ALLOW_BASE_OVERWRITE) and its safe defaults."""
    mode: str = 'auto'
    base_table: str = BASE_TABLE
    output_table: str = PREVIEW_TABLE
    email_column: str = DEFAULT_EMAIL_COLUMN
    include_unmatched: bool = False
    min_match_rate: float = DEFAULT_MIN_MATCH_RATE
    allow_base_overwrite: bool = False


def norm(name: str) -> str:
    """A name compared ignoring case and everything but letters and digits."""
    return re.sub(r'[^a-z0-9]', '', name.casefold())


def safe_name(name: str) -> str:
    """A new column's name, with the characters Delta can't take replaced by underscores."""
    return _INVALID.sub('_', name)


def email_key(value):
    """Spark's lower(trim(value)): trim removes spaces only."""
    return None if value is None else str(value).strip(' ').lower()


def _blank(key) -> bool:
    return key is None or key == ''


def validate_config(cfg: Config) -> None:
    if cfg.mode not in MODES:
        raise ValueError("MODE must be 'auto', 'enrich' or 'standalone'.")
    if cfg.include_unmatched is not False:
        raise ValueError('INCLUDE_UNMATCHED_WORKDAY must be False: Entra population is authoritative.')
    rate = cfg.min_match_rate
    if (isinstance(rate, bool) or not isinstance(rate, (int, float)) or not math.isfinite(rate)
            or not 0 <= rate <= 1):
        raise ValueError('MIN_WORKDAY_MATCH_RATE must be finite and between 0 and 1.')
    # Restrict identifiers so the same-table guard can't be bypassed with quoting.
    for name in (cfg.base_table, cfg.output_table):
        if not isinstance(name, str) or not _TABLE.fullmatch(name):
            raise ValueError('Use an unquoted schema.table identifier for BASE_TABLE and OUTPUT_TABLE.')
    if cfg.base_table.casefold() == cfg.output_table.casefold() and cfg.allow_base_overwrite is not True:
        raise ValueError('Publishing over BASE_TABLE requires deliberate ALLOW_BASE_OVERWRITE = True.')
    if not isinstance(cfg.email_column, str) or not norm(cfg.email_column):
        raise ValueError('WORKDAY_EMAIL_COLUMN must explicitly identify an email header.')


def validate_names(names, workday: bool = False) -> None:
    seen = set()
    for name in names:
        key = norm(name)
        if not key:
            raise ValueError('Empty or unusable column name.')
        if key.startswith('vlwd') or key in ('wdjoin', 'basejoin'):
            raise ValueError('Reserved private helper column in input schema.')
        identity = key if workday else name.casefold()
        if identity in seen:
            raise ValueError('Ambiguous headers after normalization.' if workday
                             else 'Ambiguous case-insensitive baseline columns.')
        seen.add(identity)


def _email_index(cfg: Config, columns) -> int:
    found = [i for i, name in enumerate(columns) if norm(name) == norm(cfg.email_column)]
    if len(found) != 1:
        raise ValueError('Workday must have the configured work-email column.')
    return found[0]


def _distinct_workday(rows, email: int):
    """The Workday checks both modes share. Returns the distinct rows in first-seen order (exact
    duplicates collapse) and the row for each email key."""
    if any(_blank(email_key(row[email])) for row in rows):
        raise ValueError('Workday contains blank work-email keys.')
    if not rows:
        raise ValueError('Workday export parsed 0 rows.')
    distinct = list(dict.fromkeys(tuple(row) for row in rows))
    by_key = {}
    for row in distinct:
        key = email_key(row[email])
        if key in by_key:
            raise ValueError('Conflicting duplicate Workday email keys; resolve the export upstream.')
        by_key[key] = row
    return distinct, by_key


def enrich(cfg: Config, base_columns, base_rows, columns, rows):
    """The notebook's `enrich_additive`: (columns, rows, diagnostics), the baseline first and unchanged."""
    validate_config(cfg)
    validate_names(base_columns)
    validate_names(columns, workday=True)
    people = [i for i, name in enumerate(base_columns) if name.casefold() == 'personid']
    if len(people) != 1:
        raise ValueError('Baseline must have a PersonId column.')
    person = people[0]
    email = _email_index(cfg, columns)

    baseline = {norm(name) for name in base_columns}
    metadata = {norm(name) for name in METADATA}
    additions, skipped = [], 0
    for i, source in enumerate(columns):
        target = safe_name(source)
        if norm(source) in baseline or norm(target) in baseline:
            skipped += 1
            continue
        if norm(target) in metadata:
            raise ValueError('Workday cannot provide absent system metadata.')
        additions.append((i, target))

    keys = [email_key(row[person]) for row in base_rows]
    if any(_blank(key) for key in keys):
        raise ValueError('Baseline contains blank PersonId keys.')
    if len(set(keys)) != len(keys):
        raise ValueError('Duplicate normalized baseline PersonId keys would cause Graph fanout.')
    if not base_rows:
        raise ValueError('Baseline is empty; refusing empty output.')

    distinct, by_key = _distinct_workday(rows, email)
    matched = sum(1 for key in keys if key in by_key)
    match_rate = matched / len(distinct)
    if match_rate < cfg.min_match_rate:
        raise ValueError(f'Workday match rate {match_rate:.1%} is below MIN_WORKDAY_MATCH_RATE.')

    add_normalized = norm('PersonId_Normalized') not in baseline
    add_total = norm('TotalEmployees') not in baseline
    add_source = norm('OrgData_Source') not in baseline
    out_columns = list(base_columns) + [target for _, target in additions]
    out_columns += [name for name, add in zip(METADATA, (add_normalized, add_total, add_source)) if add]
    total = str(len(base_rows))
    out_rows = []
    for row, key in zip(base_rows, keys):
        match = by_key.get(key)
        values = list(row) + [None if match is None else match[i] for i, _ in additions]
        if add_normalized:
            values.append(key)
        if add_total:
            values.append(total)
        if add_source:
            values.append(ENRICH_SOURCE)
        out_rows.append(values)
    # The notebook's closing checks (unique keys, every baseline row exactly once, the baseline's
    # columns first and unchanged) hold here by construction.
    return out_columns, out_rows, {
        'base_rows': len(base_rows), 'workday_rows': len(distinct),
        'exact_duplicates_collapsed': len(rows) - len(distinct),
        'matched': matched, 'match_rate': match_rate,
        'workday_only_excluded': len(distinct) - matched,
        'output_rows': len(out_rows), 'added_workday_columns': len(additions),
        'skipped_existing_columns': skipped,
    }


def _is_on_leave(value):
    if value is None or str(value).strip(' ') == '':
        return None
    return 'TRUE' if str(value).strip(' ').lower() in _ON_LEAVE else 'FALSE'


def standalone(cfg: Config, columns, rows):
    """The notebook's `land_standalone`: an email-keyed org snapshot from the export alone."""
    validate_config(cfg)
    validate_names(columns, workday=True)
    email = _email_index(cfg, columns)
    metadata = {norm(name) for name in METADATA}
    for name in columns:
        if norm(name) in metadata:
            raise ValueError('Workday cannot provide system metadata in standalone mode.')
        if norm(name) == 'personid' and (name != 'PersonId' or columns[email] != name):
            raise ValueError('Raw PersonId must be exactly named PersonId and explicitly selected as the email key.')
    distinct, _ = _distinct_workday(rows, email)
    total = len(distinct)

    # Raw values are kept; a name matching a canonical field takes its spelling, others only lose
    # the characters Delta can't take.
    canonical = {norm(name): name for name in CANONICAL}
    out_columns = [canonical.get(norm(name), safe_name(name)) for name in columns]
    out_rows = [list(row) for row in distinct]
    lookup = {norm(name): i for i, name in enumerate(out_columns)}

    def append(name, values):
        lookup[norm(name)] = len(out_columns)
        out_columns.append(name)
        for row, value in zip(out_rows, values):
            row.append(value)

    def append_if_absent(name, values):
        if norm(name) not in lookup:
            append(name, values)

    def mapped(candidates):
        for candidate in candidates:
            index = lookup.get(norm(candidate))
            if index is not None:
                return [row[index] for row in out_rows]
        return [None] * total

    person = [email_key(row[email]) for row in out_rows]
    if 'personid' in lookup:
        # Only a raw `PersonId` that is also the email column gets here; it's replaced in place.
        index = lookup['personid']
        for row, value in zip(out_rows, person):
            row[index] = value
    else:
        append('PersonId', person)
    append_if_absent('id', person)
    for target, candidates in ALIASES.items():
        append_if_absent(target, mapped(candidates))
    append_if_absent('IsOnLeave', [_is_on_leave(value) for value in mapped(['On_Leave'])])
    for name in GRAPH_FIELDS:
        append_if_absent(name, [None] * total)
    append('PersonId_Normalized', [email_key(value) for value in mapped(['PersonId'])])
    append('TotalEmployees', [str(total)] * total)
    append('OrgData_Source', [STANDALONE_SOURCE] * total)
    return out_columns, out_rows, {
        'mode': 'standalone', 'workday_rows': total, 'output_rows': total,
        'exact_duplicates_collapsed': len(rows) - total, 'match_rate': None,
    }


def prepare(cfg: Config, columns, rows, read_base):
    """The notebook's `prepare_org_snapshot`: AUTO decides on the baseline's existence alone, never by
    falling back after an error. `read_base()` returns the baseline as (columns, rows), or None when
    there's no baseline table; standalone mode never calls it."""
    validate_config(cfg)
    if cfg.mode == 'standalone':
        return standalone(cfg, columns, rows)
    base = read_base()
    if base is not None:
        out_columns, out_rows, diagnostics = enrich(cfg, base[0], base[1], columns, rows)
        diagnostics['mode'] = 'enrich'
        return out_columns, out_rows, diagnostics
    if cfg.mode == 'enrich':
        raise ValueError('Baseline table is missing. Run the Graph org-data ingester first or select AUTO/standalone.')
    return standalone(cfg, columns, rows)


def read_csv(files):
    """Read the export as the notebook's Spark reader does: a header row, quoted values over several
    lines, blank lines skipped, every value a string with '' as None (nothing trimmed), and a row of
    the wrong width failing the run (FAILFAST). `files` is [(name, bytes)]; files are combined and must
    share one header. Returns (columns, rows).

    Stricter than Spark on one point: a file that isn't UTF-8 fails here, where Spark would replace
    the characters it can't decode."""
    if not files:
        raise ValueError('No CSV paths supplied.')
    expected, rows = None, []
    for name, data in files:
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ValueError(f'{name} is not UTF-8 text. Save the Workday report as CSV UTF-8 and upload it '
                             f'again.') from None
        reader = csv.reader(io.StringIO(text, newline=''))
        header, workers = None, 0
        try:
            for record in reader:
                if not record:
                    continue
                if header is None:
                    header = [(value or '').replace('\ufeff', '').strip() for value in record]
                    validate_names(header, workday=True)
                    if expected is not None and header != expected:
                        raise ValueError('CSV files have different headers or column order; stage one '
                                         'consistent export.')
                    expected = header
                    continue
                if len(record) != len(header):
                    raise ValueError(f'{name}: the row ending on line {reader.line_num} has {len(record)} value(s) '
                                     f'and the header has {len(header)}. Fix the export and upload it again.')
                rows.append([None if value == '' else value for value in record])
                workers += 1
        except csv.Error as exc:
            raise ValueError(f'{name}: unreadable CSV near line {reader.line_num}: {exc}') from None
        if header is None:
            raise ValueError('An export file is empty.')
        if not workers:
            raise ValueError('An export file contains a header but no workers.')
    return expected, rows
