"""Org-data snapshot: port of Copilot_Org_Data_Direct_Ingester.ipynb (pure Python).

Input is the list of Graph `/users` objects (with `manager` expanded); output is the
`copilot_org_data` table as (columns, rows). Every column is a string, as in the notebook.
"""
from __future__ import annotations

import re

TABLE = 'copilot_org_data'
USERS_URL = ('https://graph.microsoft.com/v1.0/users?$select=userPrincipalName,displayName,department,'
             'jobTitle,companyName,officeLocation,city,country,accountEnabled,usageLocation,state,'
             'employeeType,employeeHireDate,userType,employeeOrgData,onPremisesExtensionAttributes'
             '&$expand=manager($select=userPrincipalName)&$top=999')
MAX_ORG_LEVELS = 14
BASE_COLUMNS = ['PersonId', 'displayName', 'Organization', 'JobTitle', 'companyName', 'officeLocation',
                'city', 'country', 'accountEnabled', 'managerUPN', 'usageLocation', 'state',
                'employeeType', 'employeeHireDate', 'userType', 'costCenter', 'division',
                *[f'extensionAttribute{i}' for i in range(1, 16)]]
HIER_FIXED = ['OrgLevel', 'HierarchyPath', 'TopOfChain_Name', 'IsManager', 'DirectReports', 'HierarchyError',
              'OrgPath']
HIER_LEVELS = [f'Level{i}_Name' for i in range(MAX_ORG_LEVELS + 1)]
HIER_COLUMNS = HIER_FIXED + HIER_LEVELS
COLUMNS = BASE_COLUMNS + HIER_COLUMNS + ['PersonId_Normalized', 'TotalEmployees']
_INVALID = re.compile(r'[ ,;{}()\n\t=]')


def org_extra_columns(headers, aliases, excluded=()):
    """Map custom org headers to portable SQL/Delta names; never merge distinct headers."""
    def norm(name):
        return re.sub(r'[ _\-]', '', name).lower()

    known = {norm(a) for c, names in aliases.items() for a in [c] + names}
    ignored = {norm(c) for c in excluded}
    used = {c.casefold(): c for c in [*aliases, *excluded, '_loaded_at', '__source_file']}
    result = {}
    for header in sorted(set(headers)):
        if norm(header) in known or norm(header) in ignored:
            continue
        safe = re.sub(r'[^A-Za-z0-9_]', '_', header)
        if not safe or not safe.strip('_'):
            raise ValueError('Org attribute has no usable column name.')
        if safe[0].isdigit():
            safe = 'attribute_' + safe
        if len(safe) > 128:
            raise ValueError('Org attribute name exceeds the 128-character SQL column limit.')
        prior = used.get(safe.casefold())
        if prior is not None and prior != header:
            raise ValueError('Org attribute names collide after sanitisation; rename the source columns.')
        if safe.casefold() in ('_loaded_at', '__source_file'):
            raise ValueError('Org attribute name is reserved for ingestion.')
        used[safe.casefold()] = header
        result[header] = safe
    return result


def _validate_users_page(data, page_number):
    if not isinstance(data, dict):
        raise ValueError(f'Graph /users page {page_number} did not return an object.')
    if 'value' not in data:
        raise ValueError(f"Graph /users page {page_number} is missing required 'value'; refusing to overwrite org data.")
    value = data['value']
    if not isinstance(value, list):
        raise ValueError(f"Graph /users page {page_number} returned a non-list 'value'; refusing to overwrite org data.")
    next_link = data.get('@odata.nextLink')
    if next_link is not None and (not isinstance(next_link, str) or not next_link.strip()):
        raise ValueError(f"Graph /users page {page_number} returned an invalid '@odata.nextLink'.")
    for item_number, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise ValueError(f'Graph /users page {page_number} item {item_number} is not an object.')
    return value, next_link


validate_users_page = _validate_users_page


def _normalise_identity(value):
    return (value or '').strip().lower()


def _canonical_org_row(user):
    def scalar(value):
        if value is None:
            return None
        if isinstance(value, (dict, list)):
            raise ValueError('Org attribute must be scalar.')
        return str(value)

    if not isinstance(user, dict):
        raise ValueError('Org data item is not an object.')
    norm = _normalise_identity(user.get('userPrincipalName'))
    if not norm:
        raise ValueError('Org data row is missing userPrincipalName; refusing to write an anonymous identity.')
    manager = user.get('manager')
    manager_upn = ''
    if manager not in (None, ''):
        if not isinstance(manager, dict):
            raise ValueError(f'Org data row {norm!r} has a non-object manager payload.')
        manager_upn = manager.get('userPrincipalName', '') or ''
    row = {
        'PersonId':         user.get('userPrincipalName'),
        'displayName':      user.get('displayName'),
        'Organization':     user.get('department'),
        'JobTitle':         user.get('jobTitle'),
        'companyName':      user.get('companyName'),
        'officeLocation':   user.get('officeLocation'),
        'city':             user.get('city'),
        'country':          user.get('country'),
        'accountEnabled':   str(user.get('accountEnabled', '')),
        'managerUPN':       manager_upn,
    }
    for field in ('usageLocation', 'state', 'employeeType', 'employeeHireDate', 'userType'):
        row[field] = scalar(user.get(field))
    for parent, fields in (
        ('employeeOrgData', ('costCenter', 'division')),
        ('onPremisesExtensionAttributes', tuple(f'extensionAttribute{i}' for i in range(1, 16))),
    ):
        nested = user.get(parent)
        if nested is None:
            nested = {}
        if not isinstance(nested, dict):
            raise ValueError(f'Org data has a non-object {parent} payload.')
        for field in fields:
            row[field] = scalar(nested.get(field))
    return row


def _dedupe_org_rows(rows):
    seen = {}
    deduped = []
    for row in rows:
        norm = _normalise_identity(row.get('PersonId'))
        comparable = {key: '' if value is None else str(value).strip() for key, value in row.items()}
        prior = seen.get(norm)
        if prior is None:
            seen[norm] = comparable
            deduped.append(row)
            continue
        if comparable != prior:
            raise ValueError(f'Conflicting org rows detected for {norm!r}; refusing to overwrite a good snapshot.')
    return deduped


def build_hierarchy(rows, max_levels=MAX_ORG_LEVELS):
    """Flatten each person's managerUPN chain into Level0..N + org metadata.

    Cycle-tolerant: a cycle truncates the chain and is recorded in HierarchyError.
    Someone who is their own manager is the top of their chain, not an error.
    OrgPath is the chain as lower-case UPNs joined by '|' (top first), the form DAX PATHCONTAINS reads.
    """
    def _n(v):
        return (v or '').strip().lower()

    name_of, mgr_of = {}, {}
    for row in rows:
        user = _n(row.get('PersonId'))
        if not user:
            continue
        name_of[user] = (row.get('displayName') or row.get('PersonId') or '').strip()
        mgr_of[user] = _n(row.get('managerUPN'))

    direct = {user: 0 for user in name_of}
    for user, manager in mgr_of.items():
        if manager and manager != user and manager in direct:
            direct[manager] += 1

    out = {}
    for user in name_of:
        chain, seen_chain, cur, error = [], set(), user, ''
        while cur and cur in name_of:
            if cur in seen_chain:
                error = f'Cycle detected at {cur!r}'
                break
            seen_chain.add(cur)
            chain.append(cur)
            manager = mgr_of.get(cur, '')
            cur = '' if manager == cur else manager
        chain = list(reversed(chain))
        rec = {column: '' for column in HIER_COLUMNS}
        for idx in range(max_levels + 1):
            rec[f'Level{idx}_Name'] = name_of.get(chain[idx], '') if idx < len(chain) else ''
        rec['OrgLevel'] = str(max(len(chain) - 1, 0))
        rec['HierarchyPath'] = ' > '.join(name_of.get(node, node) for node in chain)
        rec['TopOfChain_Name'] = name_of.get(chain[0], '') if chain else ''
        rec['IsManager'] = 'TRUE' if direct.get(user, 0) > 0 else 'FALSE'
        rec['DirectReports'] = str(direct.get(user, 0))
        rec['HierarchyError'] = error
        rec['OrgPath'] = '|'.join(chain)
        out[user] = rec
    return out


def access_people(rows):
    """`access_people` for org-scoped access: [(PersonId, OrgPath)], one per person, lower-case.

    Keeps a row's OrgPath when it has one (Graph org data); otherwise, e.g. a Workday-only org table,
    builds it from the managerUPN chain. A blank or missing PersonId is skipped.
    """
    def _n(v):
        return (v or '').strip().lower()

    computed = None
    out = {}
    for row in rows:
        person = _n(row.get('PersonId'))
        if not person or person in out:
            continue
        path = _n(row.get('OrgPath'))
        if not path:
            if computed is None:
                computed = build_hierarchy(rows)
            path = computed.get(person, {}).get('OrgPath') or person
        out[person] = path
    return sorted(out.items())


LOW_DEPARTMENT_COVERAGE = 0.8


def department_coverage(departments):
    """(people with a department, people) for the `Organization` values of an org table."""
    values = list(departments)
    have = sum(1 for v in values if v is not None and str(v).strip())
    return have, len(values)


def coverage_message(have, total):
    """One line on department coverage, with advice when views by department would leave many out."""
    line = f'{have:,} of {total:,} people have a department'
    if not total or have / total >= LOW_DEPARTMENT_COVERAGE:
        return line
    return (f'{line}. Views by department leave out everyone without one: fill in Department on users '
            'in Microsoft Entra ID.')


def build_snapshot(users, *, table_exists=False, allow_empty=False):
    """Graph users -> (columns, rows) for `copilot_org_data`."""
    rows = _dedupe_org_rows([_canonical_org_row(user) for user in users])
    hier = build_hierarchy(rows, MAX_ORG_LEVELS)
    blank = {column: '' for column in HIER_COLUMNS}
    for row in rows:
        row.update(hier.get((row.get('PersonId') or '').strip().lower(), blank))
    total = len(rows)
    if total == 0:
        if table_exists:
            raise ValueError(f'Fetched 0 org rows; refusing to replace existing {TABLE}.')
        if not allow_empty:
            raise ValueError(f'Fetched 0 org rows and {TABLE} does not exist yet. '
                             'Set ALLOW_EMPTY_SNAPSHOT only for an intentional empty first install.')
    out = []
    for row in rows:
        pid = row.get('PersonId')
        out.append([row.get(c) for c in BASE_COLUMNS + HIER_COLUMNS]
                   + [None if pid is None else str(pid).strip().lower(), str(total)])
    return [_INVALID.sub('_', c) for c in COLUMNS], out
