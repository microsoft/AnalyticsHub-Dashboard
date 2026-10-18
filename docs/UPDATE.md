# Update or remove

<a id="update"></a>
Keep Analytics Hub current, change what it collects, replace secrets before they expire, or
[remove it](#uninstall). Set it up by hand? See [Manual install: Update](MANUAL-INSTALL.md#update).
Running the [Copilot Managed App](MANAGED-APP.md) *(preview)*? Get the latest code and run
`ms app deploy` again.

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

On Azure, both also update the Teams app in your org's app catalog when its package has changed,
rather than add another. See [Give it to everyone](../azure/teams/README.md#give-it-to-everyone).

To [load more audit history](../installer/README.md#load-more-audit-history), choose **Repair or
change** once the first load has finished, or `run --backfill-days <n>`.

When a version moves work from the semantic model into the processor, follow
[Model slimming: Deploy order](MODEL-SLIMMING.md#deploy-order). Rebuild all curated months,
publish the required physical columns, and refresh all model partitions before switching the
app. The changed processor version also forces that rebuild on the next scheduled run.
A model can refresh with typed-null compatibility columns before then, but this does not mean
its data is ready. Keep the prior model available until the new model's results are verified.

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

Networking can't be changed in place. [Uninstall](#uninstall), then install again.

## Uninstall

Open the installer and choose **Uninstall** (`uninstall`). It asks before it deletes anything.

| Where | What it deletes |
|---|---|
| Fabric | The workspace and everything in it, after its managed private endpoints. If the installer didn't create the workspace, the answer defaults to no. It waits up to ten minutes for the endpoints to go. |
| Azure | The resource group the installer created. In a resource group you already had, only the resources tagged `valuelens-install-id`. Also the Power BI VNet data gateway and connection, and the **Analytics Hub** and SQL reader app registrations, if it created them. And the Teams app it looks after in your org's app catalog: the one it published, or a hand upload of the same app that it found there and took on. That takes one more sign-in as a Teams Administrator or Global Administrator. |

### What's left behind

Uninstall leaves these alone. Remove them yourself if you no longer need them:

- On Fabric, the **Analytics Hub Data Collector** app registration. Delete it in
  [Entra ID](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade).
- On Azure, the Power BI workspace and its models.
- On Azure, a Teams app in your org's app catalog that the installer never looked after, or one it
  couldn't delete. A Teams admin deletes it in the
  [Teams admin center](https://admin.teams.microsoft.com/policies/manage-apps) under **Teams apps** >
  **Manage apps**.
- On Azure, the consent to `AppCatalog.ReadWrite.All` for Microsoft Graph Command Line Tools, if someone
  gave it. To revoke it, see [Permissions](PERMISSIONS.md#publishing-the-teams-app).
- The **Analytics Hub Viewers** group.
- The Key Vault, if you used one, and its secret.
- The Power Automate flows and their connections, and the Cowork Dataflow's connections.
- Dataverse access for Agent Evaluator, and the Azure and Entra roles the installer gave.
- Your install record in `Documents\Analytics Hub` (`~/analytics-hub` in Cloud Shell).
- A [Copilot Managed App](MANAGED-APP.md), if you deployed one. Run
  [`ms app delete`](https://learn.microsoft.com/microsoft-365/managed-apps/developer/ms-cli-command-reference#ms-app-delete)
  from the `app` folder.

### Remove the installer

The exe and the PowerShell one-liner unpack to `%LOCALAPPDATA%\AnalyticsHub`; Cloud Shell to
`~/.analytics-hub`. To remove them:

- **The exe:** delete it, and `%LOCALAPPDATA%\AnalyticsHub`.
- **PowerShell:** run `.\install.ps1 -Uninstall`, or delete `%LOCALAPPDATA%\AnalyticsHub`.
- **Cloud Shell:** run
  `& ([scriptblock]::Create((irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1))) -Uninstall`,
  or delete `~/.analytics-hub`.

Neither touches what's in your tenant. Uninstall that first.
