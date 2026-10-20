# Azure

**Path 2.** Just the steps: [2-azure](../2-azure/). This page has the details.

Analytics Hub running in **your own Azure subscription**, without Microsoft Fabric. It has the
same data, the same ValueLens Model and measures, and the same app pages as [Fabric](../fabric/README.md).
The design and the roadmap are in [`DESIGN.md`](DESIGN.md).

> **Status.** The installer deploys it end to end: Azure SQL, the Container Apps jobs, the Power BI
> models, the web app, and a Teams app it publishes to your org's app catalog. It collects Copilot interactions, licences and org data, Microsoft
> 365 activity, credit consumption (Copilot Studio, Cowork, Azure AI and pay-as-you-go), and optionally
> Defender shadow AI and agent risk, the Agent 365 registry and product feedback (both from their CSV
> exports). The other modules are coming. Try it in a demo or test tenant first.

## Install it

1. Start the installer with the [PowerShell one-liner](../docs/INSTALL.md#from-powershell), or
   [download the exe](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)
   (0.3.0 or later) and open it, or run `npx valuelens-install --ui` from `installer` after
   `npm install` (see [Without the exe](../docs/INSTALL.md#without-the-exe)). To check a
   download, see [Check the download](../docs/INSTALL.md#check-the-download).
2. Pick **Your Azure subscription** and tick the data to collect. **Change the advanced settings?**
   **No** takes the defaults that suit most organisations: see
   [Advanced settings](../installer/README.md#advanced-settings). With **Yes** you can also
   choose which data the dashboard shows:
   - **Your tenant's data** (the default) collects from the audit log and Microsoft Graph.
   - **Demo mode (sample data)** publishes a synthetic sample instead, with its dates moved forward to end
     last week. It's handy for a demo or to try Analytics Hub before the Graph permissions are granted. Run
     the installer again, choose **Repair or change**, then **Yes** for the advanced settings, and pick
     your tenant's data to switch; the next run replaces the sample.
3. Choose the subscription, resource group, region and Power BI workspace. The installer only offers
   regions that your Azure Policy allowed locations permit and where everything it deploys is
   available. It says why the others were left out.
4. Review the plan and approve it. The installer prints the web app's URL and writes `AnalyticsHub-Teams.zip`,
   the tab for Teams, Outlook and the Microsoft 365 Copilot app. If you're a Teams Administrator or Global
   Administrator, it also publishes the tab to your org's app catalog, after one more sign-in
   ([what it needs](teams/README.md#give-it-to-everyone)).

No installer? Set it up [by hand](../docs/MANUAL-INSTALL.md#azure) in Azure Cloud Shell.

## Share it

Who can open the web app and the Teams tab is one Entra group, **Analytics Hub Viewers**, which the
installer creates with you as owner (or a group you name). It also gives the group **Build** on the
models. To share, add people to the group:

- **In the app:** choose **Share**. Group owners and `AnalyticsHub.Admin` can add people or groups
  and remove them; everyone else sees who to ask. **Copy app link** copies the URL.
- **In the installer:** **Manage access** (`access`).
- **In [My Groups](https://myaccount.microsoft.com/groups)**, as an owner.

The `AnalyticsHub.User` app role still works too. People without access get a page that names the
group and links to your contact or request link. In Teams, the installer publishes the tab to your
org's app catalog. To pin it for the group, or to upload it by hand when the installer can't, see
[teams](teams/README.md#give-it-to-everyone). Permissions are in
[Viewing Analytics Hub](../docs/PERMISSIONS.md#viewing-analytics-hub-paths-1-and-2).

What you need, networking, regions and the commands are in the installer's
[Azure target section](../installer/README.md#azure-target). The images come from
`ghcr.io/microsoft/valuelens-jobs` and `valuelens-web`, tagged with the installer's version. For every
prerequisite on one page, with links to Microsoft Learn, see [Prerequisites](../docs/PREREQUISITES.md).

Read the [disclaimer](../README.md#disclaimer) too: these aren't the official Copilot reports, and
you're responsible for the data once it's in your Azure SQL database.

## Credit consumption

Tick **Credit consumption** to get the Consumption Central pages, from a second Power BI model
(*Consumption Central*) that reads the same Azure SQL database.

- **Copilot Studio credits** come from the Power Platform licensing API by default, as on Fabric. The
  installer creates a daily Power Automate flow, signed in as you through **HTTP with Microsoft Entra ID**.
  Its first run loads about six months, then it reads the last ten days. Per-user credits are best effort.
  You can choose the PPAC CSV exports instead.
- **Cowork credits**: drop the Consumption Dashboard's Viva Insights export in the `viva` folder. The
  Viva Insights Dataflow is Fabric only for now: see [Parity with Fabric](#parity-with-fabric).
- **Azure AI and pay-as-you-go**: the jobs read Cost Management and Azure Monitor with their managed
  identity. The installer gives it the roles on the subscriptions you pick, if you can assign them.

Where the files land depends on networking:

| Networking | Credit files go to | Who needs what |
|---|---|---|
| Public endpoints | The storage account's `landing` container: `studio/`, `viva/` (the flow keeps its own state in `flows/`) | Whoever signs the flow's storage connection in needs **Storage Blob Data Contributor** on the account. The installer gives it to you |
| Private networking | A SharePoint folder you choose, with `studio/` and `viva/` under it. Power Automate can't reach private storage | The jobs' managed identity needs **Sites.Selected** with read on that site. The installer grants it if you're a SharePoint or Global administrator; otherwise it prints the `Grant-PnPAzureADAppSitePermission` command for one |

The jobs read the files where they land and don't move them, the same as the Fabric notebooks. Put
exports there yourself, in the Azure portal, Azure Storage Explorer or SharePoint, or with
`az storage blob upload`: the installer's `upload` command and `--csv` are Fabric only for now, and on
Azure they stop and name the folder.

### Parity with Fabric

The jobs write the same tables as the Fabric notebooks, and the Consumption Central model and the
app's pages are the same. Source by source:

| | Fabric | Azure |
|---|---|---|
| Copilot Studio credits | The licensing API flow, PPAC exports, or both | The same |
| Who the Studio flow signs in as | You, or the app registration with `--flow-identity app` | You. `--flow-identity app` warns and is ignored |
| Copilot Cowork credits | The Viva Insights Dataflow (`coworkCredits=api`), the CSV export, or both | The CSV export. `coworkCredits=api` warns and becomes CSV, and `load-cowork` stops |
| Azure AI and pay-as-you-go | `Ingest_Azure_AI` | The jobs read the same APIs and write the same tables. **Leave Azure AI out** at the subscription question, or `--data azureAi=skip`, leaves it out |
| Where credit files land | The Lakehouse | The `landing` container, or a SharePoint folder with private networking (above) |
| Demo mode | None in the installer. `seed_sample_data.py` loads the sample by hand | Leaves credit consumption out, as if unticked, until you switch to your tenant's data |
| The model and the app's pages | Consumption Central. Unticking credit consumption keeps the model, but the app hides its pages, nothing refreshes it, and the installer stops giving access to it (access already given stays). Ticking it again reuses it | The same model, reading Azure SQL, and the same pages. Unticked, the same as Fabric, and its scheduled refresh in Power BI is turned off. It gets a new SQL reader secret only once it's ticked again |
| GitHub Copilot and negotiated rates | Not installed: notebooks you import and run by hand | Not collected. The app's pages leave GitHub Copilot out, and you set your rates under **Rates & packs** in the app, which works on both |

Why some are Fabric only for now:

- **Cowork by API.** The Viva Insights connector signs in as a person, and the Dataflow Gen2 that
  reads it needs Fabric capacity. Viva Insights has no documented export a managed identity can call,
  so the jobs read the CSV export instead.
- **`--flow-identity app`.** On Fabric the flow can sign in as the app registration, with its secret
  from Key Vault. The jobs' managed identity has no secret a flow can sign in with.
- **`upload`, `--csv` and `load-cowork`.** They write to the Lakehouse or refresh the Dataflow. The
  web installer hides them on Azure.
- **Demo mode.** The sample has credit consumption, but demo mode doesn't deploy the Consumption
  Central model yet.

### Check parity with Fabric

[`tools/parity.mjs`](tools/parity.mjs) runs the app's DAX queries against two models and compares the
results. To check Consumption Central, load the same sample into a Fabric install and an Azure
install, then compare their Consumption Central models. Both installs cost money and need the roles in
[Prerequisites](../docs/PREREQUISITES.md). Put them in the same test tenant, so one sign-in can query
both, with a new Fabric workspace and a new resource group.

1. Install both, tick **Credit consumption**, and take credits from exports only, so both read nothing
   but the sample: `install --data studioCredits=csv,coworkCredits=csv,azureAi=skip`, and the same
   with `--target azure`. On Azure, keep public endpoints and your tenant's data (not demo mode).
2. In the same calendar month on both, load these files from `samples/consumption/`:
   `StudioTenantDaily.csv`, `StudioPerAgent.csv` and `StudioPerUser.csv` for Copilot Studio, and
   `PersonServiceCreditsMetrics.csv` and `SpendingPolicyMetadata.csv` for Cowork.
   - **Fabric:** `upload` the five files with `--run`.
   - **Azure:** put the Studio files in the `landing` container's `studio/` folder and the Cowork files
     in `viva/`, for example
     `az storage blob upload --auth-mode login --account-name <storage account> -c landing -n studio/StudioTenantDaily.csv -f samples/consumption/StudioTenantDaily.csv`.
     The installer gave you Storage Blob Data Contributor; a new role can take a few minutes to
     apply. Then `run`.
3. Wait for both runs to finish. On Fabric, `status` lists the Consumption Central refreshes. On Azure,
   the run job refreshes both models before it ends, so its latest execution in `status` shows
   `Succeeded`.
4. Find each Consumption Central model's IDs. In Power BI, its address has
   `groups/<workspace ID>/datasets/<model ID>`. On Azure, `status` prints them too: the workspace ID
   first on its **Power BI** line, and the model ID on its **Consumption** line.
5. Sign in with `az login`, or set `POWERBI_TOKEN`, then compare the queries that read Consumption
   Central, one folder at a time (`--only` takes one prefix):

   ```powershell
   $a = '<Fabric workspace ID>/<model ID>'; $b = '<Azure workspace ID>/<model ID>'
   foreach ($only in 'consumption/', 'executive/executive-credit', 'freshness/consumption', 'filters/consumption') {
     node azure/tools/parity.mjs --a $a --b $b --only $only --out "parity-$($only.Split('/')[0]).json"
   }
   ```

6. Read each summary. The script exits 0 whatever it finds, so check the counts: every query should
   be `match`, or `both-empty` where neither install has data for it. The organization filter
   matches only if both installs read the same directory at about the same time.
7. Run `uninstall` on both when you're done.

## Agent 365 registry

Tick **Agent 365 registry** to list the agents in your tenant and who made them, in the same
`agents_365` table as on Fabric, so the same pages work. On Azure it comes from the registry's CSV
export. The Agent 365 API is Fabric only for now: `--data agent365=api` warns and uses the export.

1. Export it from the Microsoft 365 admin center: **Agents** > **All agents** > **Export**.
2. Drop the CSV where the jobs read it:
   - **Public endpoints:** `agent365/` in the storage account's `landing` container. The installer
     gives you **Storage Blob Data Contributor** on the account, so you can upload it.
   - **Private networking:** an `agent365` folder in the SharePoint folder you give the installer,
     which the credit files use too. The jobs' managed identity needs **Sites.Selected** with read on
     that site. The installer grants it if you're a SharePoint or Global administrator; otherwise it
     prints the command for one.
3. Each run loads the newest CSV in that folder into `dbo.agents_365`, replacing the last export. The
   jobs don't move or delete the files, and with no CSV the table stays as it is.

Good to know:

- The agent details (the agent link and behaviour labels) fill in the months the next run recomputes.
  Older months keep what they had. To fill them too, run the job once with
  `VALUELENS_PROCESS_FULL_REBUILD=true` (see [incremental processing](jobs/README.md#steps)).
- The Resource Graph agents get their Agent 365 Title ID only when the export has a `Bot Id` or
  `Entra Agent ID` column. The admin center's export doesn't, as on Fabric.
- Demo mode doesn't load the Agent 365 sample.
- Uninstalling leaves the SharePoint folder and its files alone.

## Product feedback

Tick **Product feedback** to see what people say about Copilot, in the same `user_feedback` table as
on Fabric, so the User Feedback page works. On Azure it comes from the CSV export. The flow that
saves the emailed export is Fabric only for now: `--data productFeedback=flow` (or `api`) and
`--feedback-flow` warn and use the exports.

1. Export it from the Microsoft 365 admin center: **Health** > **Product feedback** > **Export**.
2. Drop the CSV where the jobs read it, as for the Agent 365 export:
   - **Public endpoints:** `product_feedback/` in the storage account's `landing` container. The
     installer gives you **Storage Blob Data Contributor** on the account, so you can upload it.
   - **Private networking:** a `product_feedback` folder in the SharePoint folder you give the
     installer. The jobs' managed identity needs **Sites.Selected** with read on that site. The
     installer grants it if you're a SharePoint or Global administrator; otherwise it prints the
     command for one.
3. Each run reads every CSV in that folder into `dbo.user_feedback`, keeping each `Feedback Id` once
   (its latest submission), so add new exports next to the old ones. The jobs don't move or delete
   the files, and with no CSV the table stays as it is.

Good to know:

- An export without a `Feedback Id` column, or with blank ones, fails the run, as do exports with no
  rows at all. The table keeps what it had, and the rest of the run still publishes.
- Text longer than 4,000 characters is cut when it's published to Azure SQL.
- **Upload exports**, `upload` and `--csv` in the installer are Fabric only for now.
- Demo mode doesn't load the product feedback sample.
- Uninstalling leaves the SharePoint folder and its files alone.

## Ask

The app's **Ask** page answers questions about the dashboard in plain language, inline. The web app's
`POST /api/ask` sends the question to an Azure OpenAI model, which can only call the named queries in
`app/src/ask/catalogue.json`, the same DAX the pages run, with a date range and organizations. It
never writes its own DAX. Each query runs through `/api/query` as the signed-in person, so Ask sees
only what they can. The answer shows which queries it ran and links to the page each came from.

- **The model.** By default the installer creates an Azure AI Services account (`ai-<prefix>-<suffix>`)
  with a `gpt-5-mini` deployment and gives the web app's managed identity **Cognitive Services OpenAI
  User** on it. Or it uses a deployment you already have, or leaves Ask off. See
  [Ask](../installer/README.md#ask) in the installer's README. The web app reads
  `VALUELENS_ASK_ENDPOINT` and `VALUELENS_ASK_DEPLOYMENT`; without both, `/app.config.json` has no
  `ask` block and the page lists suggested questions only.
- **Limits.** Groups under 5 people are left out before the model sees a row, and at most 50 rows of
  each query reach it. A question runs at most 8 queries and keeps the last 8 turns of the
  conversation. Each person gets 20 questions every 10 minutes and 2 at once.
- **Logs.** The question and the names of the queries it ran, never the answer or the data.
- **Cost.** Billed per token on the AI Services account. Light use costs a few dollars a month.

## Private networking and Azure Policy

With **Private networking** (`publicNetworkAccess=false`), `infra/` turns public network access off
on SQL, Storage (whose firewall also denies by default), the Ask AI Services account it creates (which
gets its own private endpoint) and Log Analytics. Every subnet gets a network security group that
lets HTTP and HTTPS reach the web app's subnet. The web app's ingress stays external, so people can
open it. Container Apps logs reach Log Analytics through a diagnostic setting, in the
`ContainerAppConsoleLogs` and `ContainerAppSystemLogs` tables.

`privateDnsZoneMode` says where the `privatelink.*` zones live:

| Mode | What it does | What you need |
|---|---|---|
| `create` (default) | Creates the zones in the resource group and links them to the VNet | Nothing more |
| `existing` | Uses the zones in `privateDnsZonesResourceGroupId` (for example a Landing Zone hub) and links the VNet to them | The zones exist there, including the three AI ones when Ask is created, and you have **Private DNS Zone Contributor** on that group |
| `none` | No zones, links or DNS zone groups | A deployIfNotExists policy or your network team adds the records. Until then the jobs can't reach SQL or Storage |

When Azure Policy blocks a deployment, the installer lists each policy, assignment and resource, and
prints `az deployment group show -g <resource group> -n valuelens --query properties.error` for the
full error. For any failed deployment it also reads the deployment operations, including nested
modules, and shows each failing resource's own error. To see them yourself:
`az deployment operation group list -g <resource group> -n vl-sql --query "[?properties.provisioningState=='Failed']"`.

In public mode, SQL gets the `AllowAllWindowsAzureIps` firewall rule. A server whose public access is
off rejects it with `DenyPublicEndpointEnabled`, which happens when a policy denies SQL public access
or modifies it to `Disabled` as the server is created. On a first install the installer reads the
policy assignments, and when one does this it uses Private networking, which has no firewall rule.
Some denies still need a policy exemption: an internal-only Container Apps environment
(the web app needs public ingress), a ban on creating virtual networks, and Log Analytics shared keys
in public mode.

## What's here

| Folder | Contents |
|---|---|
| `infra/` | Bicep: a user-assigned managed identity, ADLS Gen2 (shared keys off), Log Analytics, Azure SQL serverless (Entra-only), a Container Apps environment, a scheduled run job, a manual migrate job, the web app, optional private networking and an optional Azure AI Services account for Ask. Every resource is tagged `valuelens-install-id`. The installer ships it compiled as `src/azure/main.arm.json`. See [Private networking and Azure Policy](#private-networking-and-azure-policy) |
| `jobs/` | The `valuelens-jobs` image: `python -m valuelens_jobs run --steps collect,process,publish,refresh` |
| `sql/migrations/` | Versioned `V###__*.sql` scripts and a `schema_version` table, applied by the migrate job |
| `web/` | The `valuelens-web` image: the Node service that serves the app's `dist` plus `/api/query`, `/api/ask`, `/api/settings`, `/api/version` and `/api/health` |
| `teams/` | The Teams tab manifest template (SSO) |

The processing logic lives in [`core/valuelens_core`](../core/valuelens_core). It's a DuckDB
port of `Copilot_Audit_Log_Processor`, held to the Fabric notebook row for row by
`tests/test_valuelens_core_parity.py`. **The notebook is still the source of truth**: change both together,
then run `python tests/valuelens_golden.py --regenerate` (this needs pyspark and Java) and `--check`.

## Try the processor locally

```powershell
pip install duckdb
$env:PYTHONPATH = "core;azure\jobs"
# raw\copilot_interactions_parsed\*.parquet (and optionally copilot_licensed_users, agents_365)
python -m valuelens_jobs process --data-dir .\data
# -> data\curated\copilot_interactions_curated\month-YYYYMM.parquet (one file per month)
# later runs recompute only changed months; add --full-rebuild to recompute them all
```

Or run it on single files: `python -m valuelens_core --interactions in.csv --out curated.parquet`.

## Validate the templates

```powershell
az bicep build --file "azure/infra/main.bicep" --stdout > $null
az deployment group what-if -g <rg> --template-file "azure/infra/main.bicep" --parameters "azure/infra/main.bicepparam"
```

The installer runs the same what-if for its plan screen, then deploys in incremental mode. It passes the
live SQL capacity values back in, so scale changes you make survive updates.

## After deployment (installer steps, not ARM)

ARM can't do these, so the installer:
- Grant the managed identity its Graph app roles (`AuditLogsQuery.Read.All`, `Reports.Read.All`,
  `User.Read.All` and module extras).
- Run the migrate job, which creates the database users.
- Create the web app registration with a federated credential, and the Power BI workspace, models and refresh.
- Create or find the viewer group, give it Build on the models, and pass it to the web app as `VALUELENS_ACCESS`.
- With credit consumption: the managed identity's Cost Management and Azure AI roles, write access to
  where the credit files land, the Consumption Central model, and the Copilot Studio Power Automate flow.
- With the Agent 365 registry or product feedback: write access to the `landing` container for you,
  or, with private networking, read on the SharePoint site for the managed identity.

To do them by hand, see [Azure, by hand](../docs/MANUAL-INSTALL.md#azure).
