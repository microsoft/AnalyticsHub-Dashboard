# Update

Keep Analytics Hub current, change what it collects, and replace secrets before they expire.

## Get a new version

When it opens, the installer checks
[the latest release](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest). If
there's a newer one, its window and the page say so. Download it, open it, and choose **Repair or
change** to update your install. The check sends nothing about you or your tenant, and it's
skipped if GitHub can't be reached. To turn it off, set the environment variable
`ANALYTICS_HUB_NO_UPDATE_CHECK=1`. Installers up to 0.4.2 were released from
[ValueLens](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=installer-v).

With the [PowerShell one-liner](INSTALL.md#from-powershell) or
[Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell), run the same command again. It
fetches the newest version.

What changed in each version is in the [release notes](../CHANGELOG.md).

## Repair or change, or Update

Both keep your install record and skip what's already done.

| Choose | What it does |
|---|---|
| **Repair or change** | Asks the questions again, starting from your saved answers. Use it to add or drop a data source, change an advanced setting, or fix a broken step. Nothing changes until you approve the plan. |
| **Update** (`update`) | No questions. Fabric: pushes the notebooks, pipeline and semantic model from this version. Azure: runs the preflight again and redeploys with this version's images. |

To [load more audit history](../installer/README.md#load-more-audit-history), choose **Repair or
change** once the first load has finished, or `run --backfill-days <n>`.

## Editing a report

A new version may bring a new version of a report. **Update** and **Repair or change** ask before
replacing it, because that replaces edits made in Power BI. To keep your edits, use **File** >
**Save a copy** in Power BI first and edit the copy.

## Secrets expire

In Key Vault they last 12 months; in the notebooks, 90 days unless you chose otherwise, and each
install, repair or update replaces them. **Check status** warns you 30 days before. Choose **Create
new secrets** (`rotate-secret`). Where the secret goes decides what happens:

- **Key Vault, written by the installer:** it creates and stores a new secret.
- **A vault admin adds it:** it shows the admin the same steps again, then waits for you to say
  it's done.
- **In the notebooks:** it creates a new secret, rewrites the notebooks and removes the old one.
  If you brought the app, paste its new secret when asked. Add `--secret-days <n>` to change how
  long the new one lasts.

On Azure, `rotate-secret` creates a new SQL reader secret and gives it to the Power BI connection.

## Change networking (Azure)

Networking can't be changed in place. [Uninstall](UNINSTALL.md), then install again.
