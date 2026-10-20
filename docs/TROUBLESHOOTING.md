# Troubleshooting

Find the message or symptom, then do what it says. Still stuck? Check [Known issues](#known-issues),
then [open an issue](https://github.com/microsoft/AnalyticsHub-Dashboard/issues) with the message and
the installer's version.

## Starting the installer

| Problem | What to do |
|---|---|
| Edge or Windows SmartScreen warns about the exe | It isn't code-signed yet. Check it against the release: see [Check the download](INSTALL.md#check-the-download). On a managed PC, if policy blocks it, use the [PowerShell one-liner](INSTALL.md#from-powershell) or ask your IT team. |
| Your PC blocks both the exe and the PowerShell command | Use an [IT-approved Node.js](INSTALL.md#it-approved-nodejs) if you have one, or run the installer in Azure Cloud Shell. See [Locked-down tenant / Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell). |
| `-UseInstalledNode needs Node.js on the PATH`, `The installer needs 22.13 or later`, or `needs x64 Node.js` | Ask your IT team for an approved x64 Node.js, 22.13 or later on 22.x, or 24.x. Or use another route in [Install](INSTALL.md). |
| `The Azure CLI is on Cloud Shell's own sign-in` | Run `az login --use-device-code`, then run the installer again. Or leave out `--use-az`. See [Locked-down tenant / Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell). |
| `The installer couldn't start` | Download the exe again. If that doesn't help, delete `%LOCALAPPDATA%\AnalyticsHub` and open it again. |
| The page says it needs the installer's link, or the link has expired | Go back to the installer's window and press **Enter**. It opens the page again. |

## Set-up

| Problem | What to do |
|---|---|
| `This workspace no longer exists` | The workspace in the install record was deleted, or the record is for another tenant. Choose **Start fresh**. The old record is kept, renamed with the date and time. See [Run it](INSTALL.md#run-it). |
| `No active Fabric capacity you can use` | Start a Fabric trial, or ask a capacity admin to make you a Contributor on a capacity. |
| `No Azure subscription you can use` | Ask for Contributor on a subscription, on a resource group, or for read access to an existing vault a vault admin can add the secret to. Or choose [no Key Vault](../installer/README.md#where-the-secret-goes) (`--no-key-vault`): anyone with a role in the workspace can then read the secret. |
| `This workspace is connected to Git` | With no Key Vault, the installer won't write the client secret into a Git-connected workspace. Disconnect it under **Workspace settings** > **Git integration**, or run the installer again and choose Key Vault. |
| `You can't write secrets to …` or `You can't change access policies on …` | Run the installer again without `--yes`, pick the vault, and choose **A vault admin will add the secret for me**. See [Where the secret goes](../installer/README.md#where-the-secret-goes). |
| `You can't create resource groups in this subscription` | Run the installer again and give the name of a resource group where you're a Contributor. |
| `The subscription isn't registered for Microsoft.KeyVault` | Ask a subscription Owner or Contributor to register the `Microsoft.KeyVault` resource provider, then run the installer again. |
| `Stopped until the vault admin has added the secret` | Send the admin the steps the installer showed (run `rotate-secret` to see them again). Once the secret is in the vault, run the installer again: it carries on from there. |
| `Stopped until an admin has registered the app` | Send the admin `analytics-hub-admin-pack.md` from the install folder. Once they send you the client ID, run the installer again without `--yes`. |
| `… isn't ready yet. It still needs:` | The app you brought is missing its service principal, Graph permissions or admin consent. Send the admin the link it shows, then choose **Check again**. |

## Runs and loads

| Problem | What to do |
|---|---|
| A run fails with `AADSTS7000215` | The secret doesn't match the app. Choose **Create new secrets**. |
| A run fails with `Forbidden` from Graph | Admin consent is missing or still applying. Choose **Repair or change**, then **Run now**. |
| A run fails reading the secret | The person the run uses can't read it, or a vault admin hasn't added it yet. See **Someone else takes over the pipeline?** in [After it finishes](INSTALL.md#after-it-finishes). |
| A run says Fabric's capacity was too busy (`TooManyRequestsForCapacity`) | Nothing is lost. Wait a few minutes, then choose **Rerun failed loads**. It happens most on trials and small capacities, and less once the notebooks share one Spark session. See [Load status and reruns](../installer/README.md#load-status-and-reruns). |
| `Couldn't turn on high concurrency for pipelines` | You need the workspace Admin role to change it. Ask a workspace admin to turn it on, or carry on: the notebooks start their own Spark sessions. See [Load status and reruns](../installer/README.md#load-status-and-reruns). |
| The model refresh fails with `Table '…' is not in database` | The Lakehouse's SQL endpoint hadn't caught up with tables the run had just written. The refresh notebook syncs the endpoint first, so this is rare. Wait a couple of minutes, then choose **Rerun failed loads** or **Refresh the models**. |
| A run failed and you want to know which source | Its cards say. Or query `dbo.load_log` in the Lakehouse for the run: each row has the source, its status and the reason. |
| Copilot interactions fails with `audit window(s) still failed` | Purview kept failing some audit queries, usually because too many ran at once. The ingester already resends and splits failing windows, and nothing was written. Wait, make sure no one is running audit searches in the Purview portal, then choose **Rerun failed loads**. Windows that succeeded are reused. If it keeps failing, see [An audit window keeps failing](../fabric/notebooks/README.md#an-audit-window-keeps-failing). |
| Copilot interactions fails with `earlier audit range(s) failed and were never recovered` | An earlier load failed and was never rerun, and the usual run doesn't go back that far. Run `run --backfill-days <n>`, with `<n>` covering the listed dates. Windows that succeeded are reused. |
| `Copilot interactions: 0 rows` after a successful run | Either the audit log had no Copilot activity in the window, or all of it was test or admin activity, such as Copilot Studio test runs (*Maker evaluation*), which the dashboard leaves out. The data check says which, with counts. People's own Copilot use appears after the next run. To keep some of the left-out activity, edit `DROP_EXCLUDE_REASONS` in the Audit Log Processor. |
| `Fabric couldn't set up the model's connection` | Turn on *Service principals can call Fabric public APIs*, then choose **Repair or change**. |
| `Couldn't connect Analytics Hub Model to …` | Open the link it shows. Under **Gateway and cloud connections**, pick `Analytics Hub SQL …` (`ValueLens SQL …` on earlier installs). Then choose **I've connected it myself**. |
| A run notes that `Refresh_Cowork_Credits` failed, or *Needs sign-in* | Most often the Dataflow has no saved connections, or it hadn't finished publishing. The refresh then fails within seconds with "Job instance failed without detail error", even if the editor's preview shows rows. Open `AnalyticsHub_Cowork_Credits`. On each **Configure connection** banner (the Viva Insights source and the Lakehouse destination), choose **Configure connection**, sign in, then **Connect**. Then choose **Save**, wait until it has finished publishing, and choose **Load Cowork now** (or run `load-cowork`). Otherwise the Viva Insights query may have stopped refreshing. The rest of the run carries on either way. |
| A flow doesn't save any files | Check it's turned on and all its connections are signed in. The Power Platform API connection must be a Power Platform, Billing or Global administrator, and the OneLake connection someone with Contributor or higher on the workspace. A 403 from OneLake usually means that person lacks the role, or the Fabric tenant setting for apps outside Fabric is off. |
| A model refresh fails with `Login failed` | The connection's secret expired. Choose **Create new secrets**. |

## The app, reports and data

| Problem | What to do |
|---|---|
| `The app wasn't deployed` | Fix the cause it shows, then choose **Redeploy the app**. |
| `OS keychain is not available and plaintext token storage is not enabled` | Run the installer from a desktop session, at the PC or over Remote Desktop, then choose **Redeploy the app** (or run `deploy-app`). Without a desktop session, for example over SSH, the app's deploy tool can't store its sign-in securely, so it stops. The rest of the set-up is done. Don't allow the plain-text storage the message offers: it keeps your sign-in unencrypted on disk. |
| `The … report wasn't published` | Fix the cause it shows, then choose **Update**. The models and data aren't affected. |
| A report's Tornado chart, Word cloud or Deneb visual is blank | Turn on the tenant setting *Allow visuals created using the Power BI SDK*. See [Power BI reports](../installer/README.md#power-bi-reports). |
| `You can't assign Azure roles in …` | See [Credit consumption](../installer/README.md#credit-consumption). |
| `You can't add … to …, so its transcripts are skipped` | See [Agent Evaluator](../installer/README.md#agent-evaluator). |
| Work patterns says the reports hide user names | See [Microsoft 365 activity](../installer/README.md#microsoft-365-activity). |
| An export isn't recognised, or is `set to Skip` | Check it's the export the card names, unedited. Or set its source to **Upload CSV** with **Repair or change**. Files the pipeline couldn't place are in `analytics_hub_uploads/_unrecognised`. |
| A page is blank | Its source is skipped, or no export has arrived yet. See [Data sources and exports](../installer/README.md#data-sources-and-exports). |

## Known issues

Limits we know about, and what to do.

### Installing

- **The exe and `install.ps1` aren't code-signed yet.** A matching SHA-256 confirms a file is the
  one in the release, not who published it. See [Check the download](INSTALL.md#check-the-download).
  If your organisation's policy blocks them, use another route in [Install](INSTALL.md) or ask
  your IT team.
- **AppLocker or WDAC can block both the exe and the PowerShell one-liner.** Use
  [IT-approved Node.js](INSTALL.md#it-approved-nodejs) if your IT team has approved one, or
  [Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell).
- **The Windows management command can lose non-ASCII paths.** `analytics-hub.cmd` is written as
  ASCII. A non-ASCII installed Node.js path or Documents path can break later uses of that command,
  even when the initial PowerShell launch works. Re-run the original approved launch command,
  where policy permits, or ask your IT team. Unicode command generation remains a follow-up to #77.
- **Cloud Shell can't sign in where Conditional Access blocks sign-in with a code.** Run the
  installer on a PC that's allowed.
- **Cloud Shell ends a session after 20 minutes without input.** Run the same command again: it
  carries on from the install record.
- **Keep the PC awake.** If it sleeps, setup stops until it wakes.
- **Run it from a desktop session: at the PC, or over Remote Desktop.** Without one, for example
  over SSH, the app's deploy tool may not be able to store its sign-in securely. A Fabric install
  then sets up everything except the app. To finish, run `deploy-app` from a desktop session. See
  [The app, reports and data](#the-app-reports-and-data).

### Unsigned files in the download

`AnalyticsHubInstaller.zip` (which the exe and `install.ps1` unpack) holds a signed `node.exe` and
these unsigned native files, all in Rayfin's packages under `f\app\node_modules`:

| File | Why it's there | When it loads |
|---|---|---|
| `@azure\msal-node-extensions\bin\x64\dpapi.node` | Encrypts Rayfin's saved sign-in with Windows DPAPI | When Rayfin signs you in itself to deploy the app on a Fabric install |
| `keytar\build\Release\keytar.node` | msal-node-extensions loads it with the DPAPI cache; Rayfin stops if it can't | Same as above |

Neither loads on an Azure install, or when the installer hands Rayfin its own sign-in (in Cloud
Shell, or when Rayfin is signed in as someone else). If policy blocks native files under your
profile, use [Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell) or ask your IT
team. The zip also has `dpapi.node` for arm64 and ia32, which never load on x64.

The download no longer includes esbuild's `esbuild.exe`, `tsx`, or msal-node-runtime's native
sign-in broker: nothing loads them when the installer runs.

### Fabric

- **A Fabric trial lasts 60 days and can't run the Ask data agent.** Move the workspace to a paid
  capacity before it ends, or its notebooks and pipeline stop.
- **The secret in the notebooks can be read by anyone with a workspace role.** That's the default
  trade-off for needing no Azure. Use a Key Vault to avoid it. See
  [Where the secret goes](../installer/README.md#where-the-secret-goes).
- **`--flow-identity app` needs a Key Vault that allows public network access.** The Key Vault
  connector can't reach a private vault.
- **The Cowork Dataflow fails until someone signs in to it.** That's expected: the load shows it as
  waiting, not failed.

### Azure

- **Some modules aren't on Azure yet:** product feedback, Agent Evaluator,
  GitHub Copilot credits and Cowork credits through the Dataflow. The Agent 365 registry loads
  from its CSV export only: its API is Fabric only for now.
- **Networking can't be changed in place.** [Uninstall](UPDATE.md#uninstall), then install again.
- **Org-scoped access isn't supported with private networking yet.** Its notebook can't reach the
  storage account. See [Org-scoped access](PERMISSIONS.md#org-scoped-access-row-level-security).
- **Container Apps logs can't be queried from a public network** with private networking, without
  an Azure Monitor Private Link Scope.

### Data

- **Figures may not match the official Copilot reports.** Analytics Hub reads the Purview audit
  log, which isn't the authoritative source. See the [disclaimer](../README.md#disclaimer).
- **Only `CopilotInteraction` audit records are read**, so third-party AI logged as
  `AIAppInteraction` isn't included.
- **Per-user Copilot Studio credits are best effort.** They come from an undocumented API route,
  and the flow only sees environments with credits allocated. Exports, where you add them, win.
- **On a large tenant, audit records that arrive more than 3 days late are missed.** See
  [A large tenant](../installer/README.md#a-large-tenant).
