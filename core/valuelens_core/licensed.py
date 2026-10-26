"""Licensed-users snapshot: port of Copilot_Licensed_Users_Direct_Ingester.ipynb (pure Python).

Input is the Graph `getOffice365ActiveUserDetail` CSV, optionally with the users listed in
the Microsoft 365 Copilot usage report; output is the `copilot_licensed_users` table as
(columns, rows) with the notebook's column names.
"""
from __future__ import annotations

import csv
import re
from io import StringIO

COPILOT_SKU_PATTERNS = [
    'MICROSOFT 365 COPILOT',
    'COPILOT FOR MICROSOFT 365',
    'M365 COPILOT',
    '=MICROSOFT 365 E7',
    '=MICROSOFT_365_E7',
    '=9a18296a-025f-4e37-9ffa-30bf8d1ce775',
]
COPILOT_SKU_EXCLUDE = [
    'VIRAL TRIAL',
    'TRIAL',
    'COPILOT STUDIO',
    'SECURITY COPILOT',
    'COPILOT CHAT',
]
TABLE = 'copilot_licensed_users'
_INVALID = re.compile(r'[ ,;{}()\n\t=]')
# M365_COPILOT_APPS: the service plan in every Microsoft 365 Copilot SKU, including EDU, Sales and E7.
COPILOT_PLAN_ID = 'a62f8878-de10-42f3-b68f-6149a25ceb97'
LIVE_USERS_URL = 'https://graph.microsoft.com/v1.0/users?$select=userPrincipalName,assignedPlans&$top=999'


def _normalise_header(value):
    return ' '.join(str(value or '').strip().lower().split())


def _pick_report_column(fieldnames, *candidates):
    lookup = {}
    for name in fieldnames or []:
        lookup.setdefault(_normalise_header(name), name)
    for candidate in candidates:
        hit = lookup.get(_normalise_header(candidate))
        if hit is not None:
            return hit
    return None


def _normalise_identity(value):
    return (value or '').strip().lower()


def _parse_active_user_report(csv_text):
    csv_text = (csv_text or '').lstrip('\ufeff')
    if not csv_text.strip():
        raise ValueError('Active-user report is empty; refusing to replace the licensed-user snapshot.')
    reader = csv.reader(StringIO(csv_text))
    try:
        fieldnames = next(reader)
    except StopIteration as exc:
        raise ValueError('Active-user report has no header row; refusing to replace the licensed-user snapshot.') from exc
    if not fieldnames:
        raise ValueError('Active-user report header is empty; refusing to replace the licensed-user snapshot.')
    upn_col = _pick_report_column(
        fieldnames,
        'User Principal Name',
        'userPrincipalName',
        'UserPrincipalName',
        'User principal name',
    )
    products_col = _pick_report_column(fieldnames, 'Assigned Products')
    if upn_col is None:
        raise ValueError("Active-user report is missing 'User Principal Name'; refusing to dedupe an unknown identity.")
    if products_col is None:
        raise ValueError("Active-user report is missing 'Assigned Products'; refusing to write false licence flags.")
    expected = len(fieldnames)
    rows = []
    for line_number, values in enumerate(reader, start=2):
        if not values or not any((value or '').strip() for value in values):
            continue
        if len(values) != expected:
            raise ValueError(
                f'Active-user report row {line_number} has {len(values)} columns; expected {expected}. '
                'Refusing to write a partial licence snapshot.'
            )
        rows.append(dict(zip(fieldnames, values)))
    return fieldnames, rows, upn_col, products_col


def _validate_report_rows(rows, upn_col):
    seen = {}
    for offset, row in enumerate(rows, start=2):
        norm = _normalise_identity(row.get(upn_col))
        if not norm:
            raise ValueError(
                f"Licensed-user row {offset} is missing '{upn_col}'; refusing to dedupe an unknown identity."
            )
        comparable = tuple((key, '' if value is None else str(value).strip()) for key, value in sorted(row.items()))
        prior = seen.get(norm)
        if prior is None:
            seen[norm] = comparable
            continue
        if comparable != prior:
            raise ValueError(
                f'Duplicate licensed-user row conflict for {norm!r}; '
                'refusing to overwrite with ambiguous snapshot data.'
            )


def _parse_copilot_usage_report(csv_text):
    """Copilot usage user-detail CSV -> set of normalised UPNs. The report lists only Copilot-enabled users."""
    csv_text = (csv_text or '').lstrip('\ufeff')
    if not csv_text.strip():
        return set()
    reader = csv.reader(StringIO(csv_text))
    fieldnames = next(reader, None) or []
    upn_col = _pick_report_column(
        fieldnames,
        'User Principal Name',
        'userPrincipalName',
        'UserPrincipalName',
        'User principal name',
    )
    if upn_col is None:
        raise ValueError("Copilot usage report is missing 'User Principal Name'.")
    index, expected = fieldnames.index(upn_col), len(fieldnames)
    users = set()
    for line_number, values in enumerate(reader, start=2):
        if not values or not any((value or '').strip() for value in values):
            continue
        if len(values) != expected:
            raise ValueError(
                f'Copilot usage report row {line_number} has {len(values)} columns; expected {expected}.'
            )
        norm = _normalise_identity(values[index])
        if norm:
            users.add(norm)
    return users


def live_copilot_licences(users, known=None, enabled=None):
    """Graph /users items (userPrincipalName, assignedPlans) -> (every UPN, UPNs with an enabled Copilot plan).

    Pass the sets back in to add one page at a time. A removed licence stays in assignedPlans with
    capabilityStatus 'Deleted', and a disabled one isn't 'Enabled', so neither counts.
    """
    known = set() if known is None else known
    enabled = set() if enabled is None else enabled
    for user in users or []:
        upn = _normalise_identity((user or {}).get('userPrincipalName'))
        if not upn:
            continue
        known.add(upn)
        if any(str((plan or {}).get('servicePlanId') or '').strip().lower() == COPILOT_PLAN_ID
               and (plan or {}).get('capabilityStatus') == 'Enabled'
               for plan in user.get('assignedPlans') or []):
            enabled.add(upn)
    return known, enabled


def _is_deleted(row):
    col = _pick_report_column(list(row), 'Is Deleted', 'isDeleted')
    return col is not None and str(row.get(col) or '').strip().lower() in ('true', 'yes', '1')


def apply_licence_checks(rows, upn_col, live=None):
    """Turn report-based HasCopilot TRUE flags FALSE for deleted users and, when `live` is given, for users
    without an enabled Copilot plan in Microsoft Entra now. Never sets TRUE. Returns counts for the log.

    `live` is `live_copilot_licences`'s (known, enabled), or None when it couldn't be read. It is skipped when
    none of the report's users are in Entra (for example, the report shows concealed names).
    """
    stats = {'deleted': 0, 'live_checked': False, 'live_removed': 0, 'live_missed': 0}
    for row in rows:
        if row.get('HasCopilot') == 'TRUE' and _is_deleted(row):
            row['HasCopilot'] = 'FALSE'
            stats['deleted'] += 1
    if live is None:
        return stats
    known, enabled = live
    if not ({_normalise_identity(row.get(upn_col)) for row in rows} & known):
        return stats
    stats['live_checked'] = True
    for row in rows:
        upn = _normalise_identity(row.get(upn_col))
        if row.get('HasCopilot') == 'TRUE':
            if upn not in enabled:
                row['HasCopilot'] = 'FALSE'
                stats['live_removed'] += 1
        elif upn in enabled and not _is_deleted(row):
            stats['live_missed'] += 1
    return stats


def _normalise_product(value):
    return ' '.join((value or '').upper().split())


def _product_tokens(products):
    return [part.strip() for part in re.split(r'[+,;]', products or '') if part.strip()]


def make_classifier(patterns=None, exclude=None):
    """Return the notebook's `_is_copilot(products) -> (matched, reason)` for the given lists."""
    pats = [_normalise_product(p) for p in (COPILOT_SKU_PATTERNS if patterns is None else patterns) if p.strip()]
    excl = [_normalise_product(e) for e in (COPILOT_SKU_EXCLUDE if exclude is None else exclude) if e.strip()]

    def _is_copilot(products: str):
        excluded = ''
        for product in _product_tokens(products):
            up = _normalise_product(product)
            exclusion = next((e for e in excl if e in up), None)
            if exclusion:
                excluded = f'excluded ({exclusion})'
                continue
            for p in pats:
                matches = (up == p[1:].strip()) if p.startswith('=') else (p in up)
                if matches:
                    return True, p
        return False, excluded

    return _is_copilot


def sanitize(name: str) -> str:
    return _INVALID.sub('_', name)


def licence_sources(rows, upn_col, is_copilot, copilot_users):
    """How each licensed user was found: by assigned product, by the Copilot usage report, or both."""
    stats = {'by_product_only': 0, 'by_report_only': 0, 'by_both': 0, 'report_users': 0, 'report_not_in_active': 0}
    if copilot_users is None:
        return stats
    active = set()
    for row in rows:
        norm = _normalise_identity(row.get(upn_col))
        active.add(norm)
        by_product = is_copilot(row.get('Assigned Products') or '')[0]
        by_report = norm in copilot_users
        if by_product and by_report:
            stats['by_both'] += 1
        elif by_product:
            stats['by_product_only'] += 1
        elif by_report:
            stats['by_report_only'] += 1
    stats['report_users'] = len(copilot_users)
    stats['report_not_in_active'] = len(copilot_users - active)
    return stats


def build_snapshot(csv_text, *, patterns=None, exclude=None, table_exists=False, allow_empty=False,
                   copilot_users=None, stats=None, live=None):
    """CSV text -> (columns, rows) for `copilot_licensed_users`. Mirrors the notebook cells 2-4.

    `copilot_users` is the set of normalised UPNs from the Copilot usage report, or None when it was not
    fetched. A user in that set counts as licensed even if no assigned product matched. `live` is
    `live_copilot_licences`'s result, or None; see `apply_licence_checks`. Pass a dict as `stats` to
    receive the `licence_sources` and `apply_licence_checks` counts.
    """
    fieldnames, rows, upn_col, _products_col = _parse_active_user_report(csv_text)
    _validate_report_rows(rows, upn_col)
    is_copilot = make_classifier(patterns, exclude)
    if stats is not None:
        stats.update(licence_sources(rows, upn_col, is_copilot, copilot_users))
    for row in rows:
        ok = is_copilot(row.get('Assigned Products') or '')[0]
        if not ok and copilot_users:
            ok = _normalise_identity(row.get(upn_col)) in copilot_users
        row['HasCopilot'] = 'TRUE' if ok else 'FALSE'
    checks = apply_licence_checks(rows, upn_col, live)
    if stats is not None:
        stats.update(checks)

    # spark.createDataFrame(list_of_dicts) orders the inferred columns by key.
    columns = sorted(rows[0].keys()) if rows else list(fieldnames)
    renamed = ['User Principal Name' if c == upn_col else 'Has license' if c == 'HasCopilot' else c
               for c in columns]
    if 'Has license' not in renamed and rows:
        raise ValueError("Expected 'HasCopilot' after licence classification.")
    out, seen = [], set()
    for row in rows:
        upn = row.get(upn_col)
        norm = None if upn is None else str(upn).strip().lower()
        if norm:
            if norm in seen:
                continue
            seen.add(norm)
        out.append([row.get(c) for c in columns] + [norm])
    if not out:
        if table_exists:
            raise ValueError(f'Fetched 0 licensed-user rows; refusing to replace existing {TABLE}.')
        if not allow_empty:
            raise ValueError(f'Fetched 0 licensed-user rows and {TABLE} does not exist yet. '
                             'Set ALLOW_EMPTY_SNAPSHOT only for an intentional empty first install.')
    return [sanitize(c) for c in renamed + ['UPN_Normalized']], out


def unmatched_copilot_products(rows_products, patterns=None, exclude=None):
    """Copilot/E7-like product names not counted, for the run log (notebook's REVIEW list)."""
    is_copilot = make_classifier(patterns, exclude)
    seen = {t for p in rows_products for t in _product_tokens(p)}
    return sorted(p for p in seen if ('COPILOT' in p.upper() or 'E7' in p.upper()) and not is_copilot(p)[0])
