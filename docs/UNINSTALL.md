# Uninstall

Open the installer and choose **Uninstall** (`uninstall`). It asks before it deletes anything.

| Where | What it deletes |
|---|---|
| Fabric | The workspace and everything in it, after its managed private endpoints. If the installer didn't create the workspace, the answer defaults to no. It waits up to ten minutes for the endpoints to go. |
| Azure | The resource group the installer created. In a resource group you already had, only the resources tagged `valuelens-install-id`. Also the Power BI VNet data gateway and connection, and the **Analytics Hub** and SQL reader app registrations, if it created them. |

## What's left behind

Uninstall leaves these alone. Remove them yourself if you no longer need them:

- On Fabric, the **Analytics Hub Data Collector** app registration. Delete it in
  [Entra ID](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade).
- On Azure, the Power BI workspace and its models.
- The **Analytics Hub Viewers** group.
- The Key Vault, if you used one, and its secret.
- The Power Automate flows and their connections, and the Cowork Dataflow's connections.
- Dataverse access for Agent Evaluator, and the Azure and Entra roles the installer gave.
- Your install record in `Documents\Analytics Hub` (`~/analytics-hub` in Cloud Shell).

## Remove the installer

The exe and the PowerShell one-liner unpack to `%LOCALAPPDATA%\AnalyticsHub`; Cloud Shell to
`~/.analytics-hub`. To remove them:

- **The exe:** delete it, and `%LOCALAPPDATA%\AnalyticsHub`.
- **PowerShell:** run `.\install.ps1 -Uninstall`, or delete `%LOCALAPPDATA%\AnalyticsHub`.
- **Cloud Shell:** run
  `& ([scriptblock]::Create((irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1))) -Uninstall`,
  or delete `~/.analytics-hub`.

Neither touches what's in your tenant. Uninstall that first.
