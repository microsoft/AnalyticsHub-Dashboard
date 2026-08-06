"""
Add a stable-superset guard to the Agents 365 Power Query in each ValueLens .pbit.

Problem (microsoft/ValueLens-for-Microsoft-Copilot#22):
The Agent 365 registry/catalogue export (PAX -IncludeAgent365Info, Graph
/beta/copilot/admin/catalog/packages) emits a 28-column inventory schema. The
model additionally declares sourced columns that only the Admin Center Agent 365
*observability* export carries (Users shared, Active Users, Total sessions,
Exception rate, Last Activity Date). The M normalises name aliases but never adds
typed-null fallbacks for the absent ones, so the schema is unstable on the
documented PAX-only path.

Fix: append a list-driven guard that adds every model-declared sourced column that
is missing as a typed null, so the query always returns the full superset.
"""
import json, os, re, shutil, sys, zipfile

DTYPE = {
    "string": "type text",
    "int64": "Int64.Type",
    "double": "type number",
    "decimal": "type number",
    "dateTime": "type datetime",
    "boolean": "type logical",
}

GUARD_HEADER = [
    '    // --- Stable superset guard (issue #22) --------------------------------',
    '    // The Agent 365 registry/catalogue export (PAX -IncludeAgent365Info, Graph',
    '    // /beta/copilot/admin/catalog/packages) emits a 28-column inventory schema.',
    '    // Observability columns (Users shared / Active Users / Total sessions /',
    '    // Exception rate / Last Activity Date) come from the Admin Center Agent 365',
    '    // export instead. Add whichever model-declared columns the chosen source did',
    '    // not supply as typed nulls, so the table always returns the same superset.',
    '    // Visuals bound to an unavailable field degrade to blank instead of breaking',
    '    // the refresh. Never overwrites a column the source did provide.',
]


def load_schema(path):
    raw = open(path, "rb").read()
    for enc in ("utf-16-le", "utf-8-sig", "utf-8"):
        try:
            txt = raw.decode(enc)
            if txt.lstrip().startswith("{"):
                return json.loads(txt), enc
        except Exception:
            pass
    raise RuntimeError(f"cannot decode {path}")


def agents_table(model):
    for t in model["model"]["tables"]:
        if t["name"].strip().lower().startswith("agents 365"):
            return t
    return None


def build_guard(missing, final_var):
    lines = list(GUARD_HEADER)
    lines.append("    __expected = {")
    for i, (name, mtype) in enumerate(missing):
        comma = "," if i < len(missing) - 1 else ""
        esc = name.replace('"', '""')
        lines.append(f'        {{"{esc}", {mtype}}}{comma}')
    lines.append("    },")
    lines.append("    __superset = List.Accumulate(")
    lines.append("        __expected,")
    lines.append(f"        {final_var},")
    lines.append("        (state, col) =>")
    lines.append("            if List.Contains(Table.ColumnNames(state), col{0}) then state")
    lines.append("            else Table.AddColumn(state, col{0}, each null, col{1})")
    lines.append("    )")
    return lines


def patch_unapplied(work, missing):
    """
    A .pbit also carries an UnappliedChanges part holding a second copy of every
    query. Power BI Desktop applies it when the template is opened, which would
    silently overwrite a DataModelSchema-only edit. Patch the Agents 365 query
    there too so both copies agree.
    """
    p = os.path.join(work, "UnappliedChanges")
    if not os.path.exists(p):
        return "absent"
    raw = open(p, "rb").read()
    for enc in ("utf-16-le", "utf-8-sig", "utf-8"):
        try:
            txt = raw.decode(enc)
            if txt.lstrip().startswith(("{", "[")):
                break
        except Exception:
            pass
    else:
        return "undecodable"

    doc = json.loads(txt)
    q = next((x for x in doc.get("queries", [])
              if x.get("name", "").strip().lower().startswith("agents 365")), None)
    if q is None:
        return "no Agents 365 query"

    body = q.get("text")
    was_list = isinstance(body, list)
    btxt = "\n".join(body) if was_list else body
    if "__superset" in btxt:
        return "already patched"

    m = re.search(r"\bin\s*\r?\n\s*(__?[A-Za-z0-9_]+|#\"[^\"]+\")\s*$", btxt)
    if not m:
        return "no final 'in <var>'"
    head = btxt[: m.start()].rstrip()
    if not head.endswith(","):
        head += ","
    new = head + "\n" + "\n".join(build_guard(missing, m.group(1))) + "\nin\n    __superset"
    q["text"] = new.split("\n") if was_list else new

    open(p, "wb").write(json.dumps(doc, ensure_ascii=False).encode(enc))
    return "patched"


def patch(pbit, dry_run=False):
    # Short working directory - some templates contain custom-visual paths that
    # exceed MAX_PATH when nested under the repo folder.
    work = os.path.join(os.environ.get("TEMP", "/tmp"), "vlw")
    if os.path.isdir(work):
        shutil.rmtree(work)
    os.makedirs(work)
    with zipfile.ZipFile(pbit) as z:
        names = z.namelist()
        z.extractall(work)

    schema_path = os.path.join(work, "DataModelSchema")
    model, enc = load_schema(schema_path)
    tbl = agents_table(model)
    if tbl is None:
        print(f"  {os.path.basename(pbit)}: no Agents 365 table - skipped")
        shutil.rmtree(work)
        return False

    part = tbl["partitions"][0]
    expr = part["source"]["expression"]
    was_list = isinstance(expr, list)
    text = "\n".join(expr) if was_list else expr

    if "__superset" in text:
        print(f"  {os.path.basename(pbit)}: guard already present - skipped")
        shutil.rmtree(work)
        return False

    # Columns the model reads from the query (sourced, not calculated).
    sourced = [c for c in tbl.get("columns", []) if not c.get("expression")]

    guaranteed = set(re.findall(r'Table\.AddColumn\([^,]+,\s*"([^"]+)",\s*each null', text))

    missing = []
    for c in sourced:
        nm = c.get("sourceColumn") or c["name"]
        if nm in guaranteed:
            continue
        missing.append((nm, DTYPE.get(c.get("dataType"), "type text")))

    if not missing:
        print(f"  {os.path.basename(pbit)}: nothing missing - skipped")
        shutil.rmtree(work)
        return False

    # The expression ends with:  in\n    <var>
    m = re.search(r"\bin\s*\r?\n\s*(__?[A-Za-z0-9_]+|#\"[^\"]+\")\s*$", text)
    if not m:
        print(f"  {os.path.basename(pbit)}: could not locate final 'in <var>' - SKIPPED")
        shutil.rmtree(work)
        return False
    final_var = m.group(1)

    head = text[: m.start()].rstrip()
    if not head.endswith(","):
        head += ","
    new_text = head + "\n" + "\n".join(build_guard(missing, final_var)) + "\nin\n    __superset"

    print(f"  {os.path.basename(pbit)}")
    print(f"      final step : {final_var}")
    print(f"      adding {len(missing)} typed-null fallback column(s):")
    for nm, mt in missing:
        print(f"        - {nm}  ({mt})")

    if dry_run:
        shutil.rmtree(work)
        return True

    part["source"]["expression"] = new_text.split("\n") if was_list else new_text

    uc = patch_unapplied(work, missing)
    print(f"      UnappliedChanges: {uc}")

    out = json.dumps(model, ensure_ascii=False, indent=2)
    with open(schema_path, "wb") as f:
        f.write(out.encode(enc))

    backup = pbit + ".bak"
    if not os.path.exists(backup):
        shutil.copy2(pbit, backup)

    tmp = pbit + ".__new"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:  # preserve original entry order
            z.write(os.path.join(work, n.replace("/", os.sep)), n)
    os.replace(tmp, pbit)
    shutil.rmtree(work)
    return True

if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    targets = [a for a in sys.argv[1:] if not a.startswith("--")]
    print("DRY RUN\n" if dry else "APPLYING\n")
    n = 0
    for t in targets:
        if patch(t, dry):
            n += 1
    print(f"\n{n} template(s) {'would be' if dry else ''} patched.")
