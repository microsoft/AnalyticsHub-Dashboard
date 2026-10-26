# Update or remove

<a id="update"></a>
Keep Analytics Hub current, change what it collects, replace secrets before they expire, or
[remove it](#uninstall). Set it up by hand? See [Manual install: Update](MANUAL-INSTALL.md#update)
for Fabric, or [Azure](MANUAL-INSTALL.md#azure).

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
| **Update** (`update`) | Skips the setup questions and keeps your saved answers. Fabric: pushes the notebooks, pipeline and semantic model from this version, and asks whether to redeploy the app too (yes by default). If Fabric can't update a model and keep its data, it asks before clearing and reloading it. Azure: runs the preflight again, shows the plan and, once you approve it, redeploys with this version's images. |

On Azure, both also update the Teams app in your org's app catalog when its package has changed,
rather than add another. See [Give it to everyone](../azure/teams/README.md#give-it-to-everyone).

On Fabric, when another installer version deployed the app, **Repair or change** offers to deploy
it again, and the answer defaults to yes, so the app matches this version's semantic model.

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
- **A vault admin adds it:** it shows the admin the same steps again, writes them to the vault
  admin's file in the admin pack, `analytics-hub-admin-pack/vault-admin.md`, then waits for you to
  say it's done. The pack it writes holds only that request: to see anything else still waiting on
  an admin, choose **Repair or change**.
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
| Fabric | The workspace and everything in it, after its managed private endpoints. If the installer didn't create the workspace, the answer defaults to no. It waits up to ten minutes for the endpoints to go. Then, in each [Agent Evaluator](../fabric/Add%20Agent%20Evaluator/README.md) environment, the transcript reader role it gave the app: it takes it away, and deletes the role if it created it. |
| Azure | The resource group the installer created. It waits up to 45 minutes for Azure to finish deleting it; add `--no-wait` to stop once Azure has accepted the delete. In a resource group you already had, only the resources tagged `valuelens-install-id`, each before what it depends on, waiting for each to go. If any are left, it lists them: run **Uninstall** again to finish, or see [Troubleshooting](TROUBLESHOOTING.md#uninstall). Also the Power BI workspace and its semantic models, if the installer created the workspace and you haven't renamed it: it asks, and the answer defaults to yes. And the Power BI VNet data gateway and connection, and the **Analytics Hub** and SQL reader app registrations, if it created them. And the Teams app it looks after in your org's app catalog: the one it published, or a hand upload of the same app that it found there and took on. That takes one more sign-in as a Teams Administrator or Global Administrator. Before the resources go, what it added in each [Agent Evaluator](../azure/README.md#agent-evaluator) environment: the transcript reader role it gave the jobs' managed identity, and the role itself if it created it, then the **Bot Transcript Viewer** role it gave, and the application user if it created it. |

### What's left behind

Uninstall leaves these alone. Remove them yourself if you no longer need them:

- On Fabric, the **Analytics Hub Data Collector** app registration. Delete it in
  [Entra ID](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade).
- On Azure, a Power BI workspace you picked rather than had the installer create, renamed, or
  chose to keep, and the models in it.
- On Azure, a personal cloud connection to the install's Azure SQL database, which Power BI made for
  whoever installed. With public endpoints it holds the SQL reader's credentials, which stop working
  once Uninstall deletes that app; with private networking it holds none. It does no harm. To delete
  it, find its ID with the Fabric REST API's
  [List Connections](https://learn.microsoft.com/rest/api/fabric/core/connections/list-connections),
  then use [Delete Connection](https://learn.microsoft.com/rest/api/fabric/core/connections/delete-connection).
- On Azure, a Teams app in your org's app catalog that the installer never looked after, or one it
  couldn't delete. A Teams admin deletes it in the
  [Teams admin center](https://admin.teams.microsoft.com/policies/manage-apps) under **Teams apps** >
  **Manage apps**.
- On Azure, the consent to `AppCatalog.ReadWrite.All` for Microsoft Graph Command Line Tools, if someone
  gave it. To revoke it, see [Permissions](PERMISSIONS.md#publishing-the-teams-app).
- The **Analytics Hub Viewers** group.
- The Key Vault, if you used one, and its secret.
- The Power Automate flows and their connections, and the Cowork Dataflow's connections.
- On Fabric, the app's application users for Agent Evaluator in Dataverse environments, with their
  **Bot Transcript Viewer** role.
- A transcript reader role an admin made, or one the installer couldn't take away or delete. The
  installer prints how a System Administrator does it.
- The Azure and Entra roles the installer gave.
  See [Remove the roles the installer gave](#remove-the-roles-the-installer-gave).
- On Azure, an Agent Evaluator application user an admin added for the jobs' managed identity, or
  one Dataverse wouldn't let the installer delete for good. The installer says which; a System
  Administrator removes it. See [Agent Evaluator](../azure/README.md#agent-evaluator).
- Your install record in `Documents\Analytics Hub` (`~/analytics-hub` in Cloud Shell).

### Remove the roles the installer gave

Some data sources need roles outside the install's resource group or workspace. The installer gave
them, or your admin did, with the commands it printed. Uninstall leaves them, so remove them
yourself if nothing else needs them:

- **On Azure,** they belong to the install's managed identity. Uninstall deletes it, and the Azure
  portal then shows the roles as **Identity not found**. Its ID is
  `azure.outputs.identityPrincipalId` in your install record.
- **On Fabric,** they belong to the **Analytics Hub Data Collector** app. Remove them before you
  delete the app. Its ID is `app.servicePrincipalId` in your install record.

| Role | On | For |
|---|---|---|
| **Reader** | The management group you picked, or the tenant root group | Foundry, from Resource Graph |
| **Global Reader**, an Entra role | Your directory | Agents, from Resource Graph |
| **Reader**, **Cost Management Reader** and **Monitoring Reader** | The Azure AI subscription | Azure AI costs and metrics |
| **Cost Management Reader** | Each pay-as-you-go subscription | Copilot pay-as-you-go costs |
| **Cognitive Services OpenAI User** | The Azure OpenAI account | On Azure, Ask with a deployment you already had |
| **AcrPull** | Your private container registry | On Azure, images from your own registry (`azure.images.registryResourceId`) |

- **Global Reader:** remove it before you uninstall, while the identity still shows by name. In the
  [Entra admin center](https://entra.microsoft.com), open **Roles & admins** > **Global Reader**,
  select the identity, and choose **Remove assignments**. It takes a Privileged Role Administrator
  or a Global Administrator.
- **The other roles,** before or after you uninstall: an Owner or User Access Administrator on each
  scope removes them. In the [Azure portal](https://portal.azure.com), open the scope's **Access
  control (IAM)** > **Role assignments**, select the identity's rows, and choose **Delete**. Or run,
  for each scope:

  ```
  az role assignment list --scope <scope> --query "[?principalId=='<its ID>'].id" -o tsv
  az role assignment delete --ids <the IDs it printed>
  ```

  A subscription's scope is `/subscriptions/<subscription ID>`. A management group's is
  `/providers/Microsoft.Management/managementGroups/<its ID>`, and the tenant root group's ID is
  your tenant ID. For the Azure OpenAI account or the registry, use its resource ID.

### Remove the installer

The exe and the PowerShell one-liner unpack to `%LOCALAPPDATA%\AnalyticsHub`; Cloud Shell to
`~/.analytics-hub`. To remove them:

- **The exe:** delete it, and `%LOCALAPPDATA%\AnalyticsHub`.
- **PowerShell:** run `.\install.ps1 -Uninstall`, or delete `%LOCALAPPDATA%\AnalyticsHub`.
- **Cloud Shell:** run
  `& ([scriptblock]::Create((irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1))) -Uninstall`,
  or delete `~/.analytics-hub`.

Neither touches what's in your tenant. Uninstall that first.
