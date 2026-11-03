# SharePoint templates

Power BI templates for a SharePoint setup: Power BI Pro models that read CSVs from a SharePoint
library, with no Fabric or Azure. Each one is copied unchanged from the repository it's built in.
Nothing here ships yet: the installer, the app and the releases don't use these files.

| File | Copied from |
|---|---|
| `ValueLens - SharePoint.pbit` | [ValueLens](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot): `4. SharePoint/ValueLens - SharePoint.pbit` |

[`provenance.json`](provenance.json) pins each copy to the commit it came from, with its git blob
ID, SHA-256 and size in bytes.

## Rules

- Don't edit a template here. Fix it upstream, then copy the fixed file and re-pin it.
- Give every file here a record in `provenance.json`.
- [`tests/test_sharepoint_templates.py`](../tests/test_sharepoint_templates.py) checks that each
  file matches its record, and that the ValueLens model keeps the tables, measures and
  parameters it was pinned with.

## Re-pin a template

1. Download the file at the new commit, byte for byte. In Windows PowerShell, type `curl.exe`:

   ```bash
   curl -L -o "sharepoint/ValueLens - SharePoint.pbit" "https://raw.githubusercontent.com/microsoft/ValueLens-for-Microsoft-Copilot/<commit>/4.%20SharePoint/ValueLens%20-%20SharePoint.pbit"
   ```

2. In `provenance.json`, update the record's `commit`, `gitBlob`, `sha256` and `bytes`. The test
   shows the file's values when they don't match. `gitBlob` must be the blob GitHub lists for
   the file at that commit:

   ```bash
   gh api "repos/microsoft/ValueLens-for-Microsoft-Copilot/contents/4.%20SharePoint/ValueLens%20-%20SharePoint.pbit?ref=<commit>" --jq .sha
   ```

3. If the model changed, update the counts at the top of the test. Then run it:
   `python -B -m pytest tests/test_sharepoint_templates.py -q`
4. Run `python scripts/Check-SharePoint-Queries.py`. In the pull request, say which of the app's
   ValueLens queries the new model answers, or stops answering.

## What the app can read from it

[`scripts/Check-SharePoint-Queries.py`](../scripts/Check-SharePoint-Queries.py) reads every query
the app sends to ValueLens. It lists the tables, columns and measures this model lacks, and where
Analytics Hub gets each one today. It only reports. Add `--json` for every query and name.
