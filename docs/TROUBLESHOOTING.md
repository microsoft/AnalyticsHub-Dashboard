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
| `You can't install into resource group …` or `You can't create resource group … and install into it` (Azure) | Ask for Owner, or Contributor and User Access Administrator. Or ask your Azure admin to set up a [least-privilege install](AZURE-LEAST-PRIVILEGE.md) in a resource group they create, then pick that group as an existing resource group. |
| `You can't register resource providers in this subscription` or `Azure says … registered in this subscription` (Azure) | Send your Azure admin the commands the installer printed. They're also in [Least-privilege Azure install](AZURE-LEAST-PRIVILEGE.md#for-your-azure-admin). |
| `DM_GWPipeline_Gateway_DataSourceAccessError` at **Power BI model** (Azure, public endpoints) | Earlier installers gave Power BI the models' Azure SQL credentials before the database migration had made the SQL reader's database user, so Power BI couldn't sign in with them. Run setup again with this version of the installer or later: it sets them after the migration, and carries on from the install record. |
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
| A run fails at `process` with `No files found that match the pattern` and a path ending in `month-….parquet` (Azure) | Installers 0.6.6 and 0.6.7 have this problem. Each run starts in a new container, and `process` read months that earlier runs had curated without downloading them. So every run after the first load, other than a full rebuild, fails there, and the dashboard stops updating. Choose **Update** with this version of the installer or later. The failed runs still collected their data, and the next run processes it. If you set `VALUELENS_PROCESS_FULL_REBUILD=true` on the run job to get by, updating removes it, since **Update** redeploys the run job's settings. |

## The app, reports and data

| Problem | What to do |
|---|---|
| `The app wasn't deployed` | Fix the cause it shows, then choose **Redeploy the app**. |
| `OS keychain is not available and plaintext token storage is not enabled` | Run the installer from a desktop session, at the PC or over Remote Desktop, then choose **Redeploy the app** (or run `deploy-app`). Without a desktop session, for example over SSH, the app's deploy tool can't store its sign-in securely, so it stops. The rest of the set-up is done. Don't allow the plain-text storage the message offers: it keeps your sign-in unencrypted on disk. |
| `The … report wasn't published` | Fix the cause it shows, then choose **Update**. The models and data aren't affected. |
| A report's Tornado chart, Word cloud or Deneb visual is blank | Turn on the tenant setting *Allow visuals created using the Power BI SDK*. See [Power BI reports](../installer/README.md#power-bi-reports). |
| `You can't assign Azure roles in …` | See [Credit consumption](../installer/README.md#credit-consumption). |
| `You can't add … to …, so its transcripts are skipped` | See [Agent Evaluator](../installer/README.md#agent-evaluator). On Azure, a System Administrator of the environment adds the jobs' managed identity by its client ID: see [Agent Evaluator on Azure](../azure/README.md#agent-evaluator). |
| `You can't give … a role that reads every transcript in …` | It's an application user there with **Bot Transcript Viewer**, which reads only the transcripts it owns or that are shared with it. A System Administrator of the environment creates a role with the ConversationTranscript table's **Read** at **Organization**, and gives it to the app or managed identity, following the steps the installer prints. Or a System Administrator runs **Update**, or **Repair or change**, and the installer does it. See [Agent Evaluator](../installer/README.md#agent-evaluator). |
| `The "…" role in … should hold only ConversationTranscript read at Organization depth` | The role holds other privileges, so the installer didn't give it. Run the installer again: it sets a role it created back to that one privilege. If it didn't create the role, rename or delete that role, then run it again. |
| `A user or team other than … has the "…" role in …` | The installer adds transcript read to its role only while no other user or team has the role, because the privilege would reach them too. Until then, the app or managed identity reads only the transcripts shared with it there. A System Administrator sees who has the role in the Power Platform admin center, under **Security roles** > the role > **More actions (...)** > **Members**, removes them from it or deletes the role, then runs the installer again. |
| `Dataverse wouldn't delete the application user for …` | Some environments won't let the installer delete it. It has no role now, so it can't read transcripts. A System Administrator deletes it in the Power Platform admin center: see [Agent Evaluator on Azure](../azure/README.md#agent-evaluator). |
| `Dataverse only soft-deleted the application user for …` or `Couldn't check that the application user for … is gone` | Dataverse's first delete of an application user only soft-deletes it, and the installer's second delete didn't remove it, or the installer couldn't check. The user is deactivated with no role, so it can't sign in or read transcripts. A System Administrator deletes it for good in the Power Platform admin center, following the steps the installer prints: **Users** > **Filter** > *Users not in Microsoft Entra ID and soft deleted in the environment* > the user > **Delete**, once any records it owns are reassigned. See [Delete users from an environment](https://learn.microsoft.com/power-platform/admin/delete-users). A soft-deleted user can't be activated again, so delete it before you tick the environment again; until then, the installer finds it disabled and skips that environment's transcripts. See [Agent Evaluator on Azure](../azure/README.md#agent-evaluator). |
| `Couldn't take the "…" role away from …` or `Couldn't delete the "…" role in …` | A System Administrator does it in the Power Platform admin center, following the steps the installer prints: **Edit security roles** on the application user, and **Security roles** > the role > **Delete**. |
| The Agent Evaluation pages are empty on Azure | They fill after the jobs' first run that reads transcripts. Run `status`: it says which environments the jobs' managed identity can read, and what the last read found. `forbidden` means it isn't an application user with **Bot Transcript Viewer** there. `empty` (`0 transcripts found in …`) when the environment has transcripts means it lacks the role that reads every transcript, as on installs from before 0.6.8: run **Update**, or **Repair or change**, as a System Administrator of the environment, then reload the history once, for example with `run --backfill-days 30`, to read the transcripts older than 14 days. See [Agent Evaluator on Azure](../azure/README.md#agent-evaluator). |
| The Agent Evaluation pages are empty on Fabric, though the environments have transcripts | The app has only **Bot Transcript Viewer** there, as on installs from before 0.6.8. Run **Update**, or **Repair or change**, as a System Administrator of each environment, then reload the history once, for example with `run --backfill-days 30`, to read the transcripts older than 14 days. See [Add Agent Evaluator](../fabric/Add%20Agent%20Evaluator/README.md). |
| Work patterns says the reports hide user names | See [Microsoft 365 activity](../installer/README.md#microsoft-365-activity). |
| An export isn't recognised, or is `set to Skip` | Check it's the export the card names, unedited. Or set its source to **Upload CSV** with **Repair or change**. Files the pipeline couldn't place are in `analytics_hub_uploads/_unrecognised`. |
| The reports are empty after the install, or have less history than you asked for | The first load may still be going: on a large tenant it takes hours, and can take more than one run. On Azure each run publishes what it has loaded, newest weeks first, so the reports fill in after each run. Run `status`. It shows the days you asked for, how much has been fetched from the audit log and what's in the reports. It also shows a load that couldn't start, such as a first load waiting for admin consent, with the command to run once that's fixed. See [How long the first load takes](../installer/README.md#how-long-the-first-load-takes). |
| A page is blank | Its source is skipped, or no export has arrived yet. See [Data sources and exports](../installer/README.md#data-sources-and-exports). |

## Uninstall

| Problem | What to do |
|---|---|
| `Analytics Hub isn't all gone from resource group …` (Azure, in a resource group you already had) | The warnings above it say why each resource is left. Run **Uninstall** again: it carries on from the install record. Remove a resource lock (`ScopeLocked`) first. A VNet stays in use while the Power BI VNet data gateway is there, and for a while after it and the Container Apps environment have gone. To finish by hand, delete the resources tagged `valuelens-install-id` with the ID it shows, in the Azure portal, in this order: the web app and jobs, the Container Apps environment, the private endpoints, the private DNS zones' virtual network links, the private DNS zones, the virtual network, the network security group, the SQL server, the storage account, the Azure AI services account, the Log Analytics workspace, and the managed identity last. Then delete the **Analytics Hub** and SQL reader app registrations in [Entra ID](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade), if they're still there. |
| `Couldn't see what's left of Analytics Hub in resource group …` (Azure) | Uninstall couldn't list the resources in the group, so it deleted none of them. The warning above it says why: usually you've lost access to the group. Once you can read it again, and delete in it, run **Uninstall** again. |

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

- **Some modules aren't on Azure yet:** GitHub Copilot credits and Cowork credits through the
  Dataflow. The Agent 365 registry loads from its CSV export only: its API is Fabric only for now.
  Product feedback loads from its CSV exports only: the emailed export flow is Fabric only for now.
- **Networking can't be changed in place.** [Uninstall](UPDATE.md#uninstall), then install again.
- **Org-scoped access isn't supported with private networking yet.** Its notebook can't reach the
  storage account. See [Org-scoped access](PERMISSIONS.md#org-scoped-access-row-level-security).
- **Container Apps logs can't be queried from a public network** with private networking, without
  an Azure Monitor Private Link Scope.
- **The schedule can start a run while another is going,** for example when a long first load
  reaches the scheduled time. The installer doesn't, but the jobs don't hold a lock yet, and two
  runs at once can leave some audit rows out. If `status` shows two runs of the run job going,
  stop the newer one with the Azure CLI:
  `az containerapp job execution list -n <run job> -g <resource group> -o table` shows when each
  started, and
  `az containerapp job stop -n <run job> -g <resource group> --job-execution-name <newer run>`
  stops it. The run job's name ends in `-run`. Later runs re-query only the last 7 days, so once
  no run is going, reload the days the two runs were loading with `run --backfill-days <n>`: for
  a first load, `<n>` is the days of history you chose. The reload is quicker before the next
  scheduled run.

### Data

- **Figures may not match the official Copilot reports.** Analytics Hub reads the Purview audit
  log, which isn't the authoritative source. See the [disclaimer](../README.md#disclaimer).
- **Only `CopilotInteraction` audit records are read**, so third-party AI logged as
  `AIAppInteraction` isn't included.
- **Per-user Copilot Studio credits are best effort.** They come from an undocumented API route,
  and the flow only sees environments with credits allocated. Exports, where you add them, win.
- **On a large tenant, audit records that arrive more than 3 days late are missed.** See
  [A large tenant](../installer/README.md#a-large-tenant).
