# Changelog

Notable, reviewed changes to Analytics Hub: the installer, the app, the Fabric notebooks and
pipeline, and the Azure target.

Analytics Hub moved here from
[ValueLens for Microsoft Copilot](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot),
where it was paths 1 (Fabric) and 2 (Azure), with its history. Entries up to 0.4.2 were written
there and refer to its folder names: `1. Fabric/installer` is now `installer/`,
`1. Fabric/Fabric App` is `app/`, `1. Fabric/Manual setup` is `fabric/`, `2. Azure` is `azure/`
and `shared/python` is `core/`. Some entries also cover the Power BI templates that stayed in
ValueLens. Releases up to 0.4.2 are on
[ValueLens's releases page](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases?q=installer-v).

Deployment instructions do **not** live here. They live in the READMEs:
[Fabric](fabric/README.md) · [app](app/README.md) · [Azure](azure/README.md) ·
[installer](installer/README.md).

---

## Unreleased

**Fixed:**

- **Azure uninstall from a resource group you already had.** It asked Azure to delete each resource
  the install had tagged with API version 2021-04-01, which most of them don't support. So it
  stopped part-way, with `NoRegisteredProviderFound`, and left the rest of those resources and the
  **Analytics Hub** and SQL reader app registrations behind. Now it uses a version each resource's
  provider offers, deletes each resource before what it depends on, and waits for Azure to finish
  each one. If one can't be deleted, it carries on, still deletes the app registrations, then lists
  what's left and exits with an error: run **Uninstall** again to finish. Uninstall from a resource
  group the installer created still deletes the whole group. 0.6.7 has this problem too.

**Azure: the installer doesn't start a run while one is going.** It used to start the run job
without checking, so a **Repair or change** during a long first load started a second run beside
it, and the two shared the audit staging area and the tenant's audit queries. Now the installer
checks the run job before the first load, a history reload, org-scoped access or `run` starts it.
If a run is going, it doesn't start another: it says which run is going, and what to run once it
has finished. A history reload that doesn't start isn't recorded, so the next **Repair or change**
offers it again. As on Fabric, `run` then exits with an error, a run that started more than 24
hours ago doesn't count, and if the installer can't check, it starts the run as before.

**Known issue:** on Azure, the schedule can still start a run while another is going, for example
when a long first load reaches the scheduled time. If it does, stop the newer run, then reload the
history once the other has finished, as [Troubleshooting](docs/TROUBLESHOOTING.md#azure) shows. A
fuller fix is planned.

**Azure: private networking no longer takes over private DNS zones already in the resource
group.** With private networking, an install creates its `privatelink.*` zones in its resource group
unless you choose otherwise. When an existing resource group already had a zone of the same name,
the deployment updated it in place and tagged it as the install's own, so uninstalling tried to
delete it, with every record in it. A second install, in a group where an earlier one had created
the zones, did the same to the first install's zones. Now the preflight stops before anything is
deployed when a zone the install would create is already there without its tag. It names the zones
and says how to go on: choose **Use existing zones in another resource group** and give that
resource group, after creating any of the zones that aren't there yet, or install into another
resource group.

- **Still goes ahead:** a Repair or Update over zones the install created itself, public networking,
  **Use existing zones**, **Leave DNS to Azure Policy or the network team**, and `privatelink.*`
  zones the install doesn't create, such as Key Vault's.
- **An install that already took over a zone** isn't detected: the zone now has that install's tag,
  and the install record doesn't say which zones were there before it.

**Fixed:**

- **Azure: a first install with public endpoints no longer stops at Power BI model** with
  `DM_GWPipeline_Gateway_DataSourceAccessError`. Public endpoints are the default unless a policy
  keeps Azure SQL private. Power BI tests the SQL reader's sign-in when it takes the models'
  credentials, but the reader's database user is made by the database migration, which ran later.
  Now a new **Power BI credentials** step sets them after **Database migration**. Private networking
  is unchanged. To finish an install that stopped there, run setup again. Every earlier installer
  with the Azure path (0.5.0 to 0.6.7) has this problem.

**Fixed:**

- **Agent Evaluator reads every Copilot Studio transcript.** The installer gave the transcript
  reader, the jobs' managed identity on Azure or the app on Fabric, only the
  **Bot Transcript Viewer** role, which reads only the transcripts the reader owns or that are
  shared with it. In a test environment, Copilot Studio's own service user owned them, so on Azure
  the first load read none, and its status said `empty`. Fabric gave its app the same role. Now, in
  each environment you pick, the installer also creates a role for the install,
  *Analytics Hub transcript reader* followed by the first 8 characters of the install's ID, with one
  privilege: ConversationTranscript read at Organization depth. It reads the role back to check
  that, gives it to the reader beside Bot Transcript Viewer, and asks Dataverse whether the reader
  can read a transcript. Unticking the environment or **Agent Evaluator**, or uninstalling, takes
  the role away and deletes it. The installer never changes or deletes a role it didn't create.
  It adds transcript read to its role only while no user or team other than the reader has the role.
  On Azure, Dataverse's first delete of an application user the installer created only
  soft-deletes it: the user stays, deactivated with no role, and ticking the environment again
  found it disabled. Now the installer reads the user back and deletes it again, and says it
  removed the user only once it's gone. Otherwise it warns, and prints how a System Administrator
  deletes it for good.
  Creating the role needs a System Administrator of the environment, as adding the reader does;
  otherwise the installer prints the admin center steps. To fix an existing install, run
  **Update** or **Repair or change** as a System Administrator of each environment, then reload
  the history once, for example with `run --backfill-days 30`. Later runs read only the last 14
  days of transcripts, and a reload reads up to 180 days, so it picks up the older ones the
  environment still keeps.

**Fixed:**

- **Azure: runs after the first load no longer fail at `process`.** Each run of the run job starts
  in a new container, with none of the earlier runs' files on its disk. `process` downloaded only
  its inputs, then read the months that earlier runs had curated from that disk. So every run after
  the first load, other than a full rebuild, failed there with
  `No files found that match the pattern` and a path ending in `month-….parquet`. Those runs didn't
  publish or refresh, so the dashboard stopped updating, and `status` showed them as Failed. Azure
  installs on 0.6.6 and 0.6.7 have this problem; Fabric doesn't. Now `process` downloads the month
  files it reads, each once a run. A full rebuild reads none of them, so it downloads none. The
  failed runs still collected their data, and the next run after you update processes it. If you
  set `VALUELENS_PROCESS_FULL_REBUILD=true` on the run job to get by, updating removes it, since
  **Update** redeploys the run job's settings. Runs then go back to recomputing only recent and
  changed months.

**Fixed:**

- **Fabric: Repair or change redeploys the app after an update.** It pushed the new version's
  semantic model, notebooks and pipeline, but its question about the app, "Deploy it again?",
  defaulted to no unless the app's pages, currency or who can view it had changed. So with the
  defaults, the app stayed at the earlier version, on the new model. Installers up to 0.6.7 have
  this problem, on Fabric only; on Azure, both Update and Repair or change redeploy the web app.
  Now the install record keeps the installer version that deployed the app. When another version
  deployed it, or the record has none, as with every install from 0.6.7 and earlier, the question
  says the app needs redeploying to update it to this version, and defaults to yes. Answer no, and
  the next Repair or change asks again. **Update** already defaulted to redeploying the app.

**Fixed:**

- **App: changing Group by no longer crashes Adoption's Trend heatmap and Activation pages.** With
  either page showing data, picking another attribute under **Group by**, such as Office location,
  or going back to Organization, replaced the whole app with "Something went wrong" and
  `Column "Chat + Agent Org DataOrganization" was not found.` **Try Again** recovered, but opened
  the Executive summary grouped by Organization, so the filters were lost. The app in 0.6.7 and
  0.6.6 has this problem too. While the answer for the new attribute loaded, these pages read the
  previous answer by the new attribute's column names, so they couldn't find the column they rank
  by. Now each answer is read by the column names of the query that asked for it: the previous
  answer stays on screen, with its own labels, until the new one comes, as it does when a filter
  changes. And a chart that can't find the column it ranks by shows its rows unranked, rather than
  stop the app.

**Azure: Share adds people by email, and shows viewers' names.** In 0.6.7 and the 0.6.8 release
candidates, on an Azure install with a viewer group, adding someone by email in **Share** failed,
even for a directory admin, with "Microsoft Entra did not allow this change. Only owners of the
viewer group and directory admins can change its members." Share also listed the people in the group
by their object ID. The web app could change the group, but it had no permission to look people up.
With the viewer group (the default), the installer now also gives it delegated Graph
`User.ReadBasic.All`. That reads basic profiles only (name, email address and photo), not
`User.Read.All`. Without a viewer group, nothing changes. Fabric isn't affected: there, Share opens
the group in My Groups.

- **Update an existing install:** run the installer and choose **Update**, or **Repair or change**.
  It adds the permission to the web app's registration and grants it, with no other step. If you
  can't grant admin consent, it gives you a link to send to an admin, as for the web app's other
  permissions.
- **When Entra refuses a lookup, Share says so.** It says Microsoft Entra didn't let Analytics Hub
  look up people by email (or groups by name), and that **Repair or change** in the installer, or
  an Entra admin's consent, fixes it. "Only owners of the viewer group and directory admins can
  change its members" is now only for a change to the group that Entra refused. With org-scoped
  access, an admin who gives or approves a scope gets the new message too, instead of a scope left
  waiting for approval or the message about owners. A scope a leader gives still waits for an
  admin.

**Fixed:**

- **A user who isn't an Entra admin can create the viewer group.** Setup, `access` and turning on
  org-scoped access stopped with Graph's 400 "Request contains a property with duplicate values"
  when they kept **A new group**. Entra makes a user who isn't an admin an owner of a security
  group they create, so Graph refused the request, which named them as owner too. Now, when Graph
  refuses it for that reason, the installer sends it again without naming them, and Entra makes
  them owner. An admin's group is created as before, naming them as owner. If Graph refuses the
  group for another reason, the installer now warns that there's no viewer group yet, and says to
  run `access` and choose **A group I already have**, instead of stopping with the error. And the
  plan before **Go ahead?** says you own the viewer group only when the installer creates it. 0.6.7
  has this problem too; its release notes list it as a Known issue.

**Fixed:**

- **Azure: turning on org-scoped access no longer fails with 403 AuthorizationPermissionMismatch.**
  The installer read the scope list from the install's storage account before it gave you
  **Storage Blob Data Contributor** there. So unless you already had that role, turning org-scoped
  access on, opening `access` once it was on, and applying it during setup could fail with that
  403. In testing, it turned on only once a test user was given the role by hand. 0.6.7 has this
  problem too, and its release notes list it as a Known issue. Now, on Azure, the installer gives
  you the role before it first reads or writes the scope list, then retries for a few minutes while
  a new role takes effect. It asks every time, even if the install gave the role to someone before,
  so a second admin gets it too; if you have it already, that counts as given. If you can't assign
  roles on the storage account but someone gave you the role, it now goes ahead; before, it could
  stop and say you needed the role. Without the role, it says to ask an Owner or User Access
  Administrator for it (Azure portal > the storage account > **Access control (IAM)**), wait about
  5 minutes and try again, instead of showing the 403. Private networking and Fabric are unchanged.

**Fixed:**

- **Azure: Repair keeps a shared-capacity (Pro) install's workspace where it is.** A Repair with
  `--yes`, or one that took every default, moved it onto your first active capacity. Installers up
  to 0.6.7 have this problem, and 0.6.7's release notes list it as a known issue. The install record
  didn't keep the choice **None (shared capacity, Pro)** at **Capacity for the Power BI workspace**,
  so Repair suggested the first active capacity instead. Now the record keeps None, and Repair
  suggests where the workspace is: the capacity you chose, if it's active; otherwise the active
  capacity the workspace is on, or None if it's on shared capacity; failing that, None if that was
  the choice. Earlier installers didn't keep None, so a record with a workspace and no capacity is
  taken to have chosen it. If the capacity you chose is paused, Repair still suggests the first
  active capacity, as before. A new install still suggests the first active capacity, and private
  networking still needs a capacity. Choosing None doesn't move a workspace off a capacity: if a
  Repair moved yours, set it back to Pro in the workspace's settings in Power BI, then run Repair
  without `--yes` and choose None. Fabric isn't affected.

**App: fetches ahead only the next two pages.** Once the page on screen has loaded, the app used
to fetch the first tab of every other page in the background, about 45 queries per open. It now
fetches the first tab of the next two pages in the menu, and the two after whichever page you open
next. Those background queries share the capacity with the page on screen, and on large tenants
each runs longer and slows the ones in front of it. Pages further down the menu load when opened,
as they did before the prefetcher. `PREFETCH_AHEAD` in `app/src/components/prefetch-targets.ts`
sets the number. On Fabric and Azure.

- **Licensed users: the Copilot usage report counts too.** The licensed-users ingest, in Fabric
  and on Azure, now also reads the Microsoft 365 Copilot usage report, which lists every
  Copilot-enabled user. A user in that report is flagged as licensed even when their assigned
  product name doesn't match the Copilot patterns, for example a renamed or bundled SKU. It uses
  the `Reports.Read.All` permission the ingest already has, so there's nothing new to grant. If the
  report returns 400, 403 or 404, the run falls back to assigned products and says so in the log.
  Other errors stop the run and keep the previous snapshot. The log shows how many users each
  source found, and warns if no names match between the two reports (concealed names).

- Installer: M365 Activity now refreshes incrementally (12 months kept, the last 35 days reloaded), instead of reloading the whole table on every refresh. The first refresh after an install or **Repair or change** still loads it all once.

- Consumption Central refresh does less work for large user counts, with the same results. The
  Studio and GitHub usage intensity groups find each percentile cut once instead of ranking every
  user against every other user, and `Weeks Ago` no longer looks up the latest week separately for
  every row. The Cowork usage cohorts are now worked out in the `CoworkBilling` query, which sorts
  the credits once and compares each user with five cut values, instead of ranking every user for
  every user. `Weeks Active` and `Weeks Over Limit` are unchanged. The overall saving still needs
  timing on a large copy.
- The Microsoft 365 activity and Agent Evaluator notebooks now compact the tables they wrote
  (`OPTIMIZE ... VORDER`) once at the end of each run, so the daily and incremental writes no
  longer pile up small files that slow down refresh. A failed compaction is reported and the load
  still succeeds. Set `RUN_OPTIMIZE = False` to turn it off.
- The Agent Evaluator report no longer loads eight columns that nothing in it reads: error
  messages, the 500-character transcript preview, the first and last bot messages, and the
  variable copies other than the user's UPN. Refresh reads less data and the model is smaller.

**Changed:**

- **The app opens on the last 12 weeks for a large organization.** When more than 10,000 people
  have Copilot activity, the date filter starts at **Last 12 weeks**, the 84 days to the last day
  with activity, rather than all dates. With 20,000 people, a three-month window made the
  Adoption summary about 30% quicker and the org-to-person drill about 15% quicker; bigger
  tenants gain more. Each query works out the tenant's size and the dates itself, so the first
  page doesn't wait for anything extra. The filter bar shows the dates and says it's the default
  for large organizations, and **Show all dates** widens it in one click. **Clear filters** is now
  **Reset filters**, and goes back to this default. Smaller tenants still start on **All dates**.
  Consumption Central and the Agent Evaluator keep every date until you choose a range.

**Fixed:**

- **Azure: scoped delegation in the Share panel no longer fails with 503.** With org-scoped access
  on, the panel couldn't show, give, take back or approve scopes: each request failed at once with
  "Couldn't reach the Analytics Hub database. Try again in a minute.", even with the database
  online, and the web app logged `SQL connection failed` with "must be an instance of the token
  credential class". The SQL driver copies its settings into plain objects, which dropped the
  managed identity's `getToken`, so it refused the identity before connecting. Now the web app
  hands the driver a credential with its own `getToken`, which survives the copy. The fault has
  been in the web app since 0.6.0, but the Share panel offers scoped delegation on Azure only since
  0.6.8-rc.2, so released versions, 0.6.7 included, couldn't reach it from the app.

**Installer: audit-ingestion checks, and the Viva Insights sign-in first.**

- **The installer checks the app can read the audit log.** After admin consent, it gets the app's
  own token and checks it's for this tenant and has `AuditLogsQuery.Read.All`. Straight after
  consent, a problem is only noted, as Entra can take a few minutes to apply a new app, secret or
  consent (an app it can't find yet is tried again too). Once the pipeline is deployed it checks
  again, and then says why the audit load would find nothing (consent missing, the secret not
  working, or an app registration from another tenant) and who fixes it. On Azure, it checks the
  jobs' managed identity has the role.
- **New `check-audit` command** (**Check audit ingestion** in the browser), and `--check-audit` for
  `install` and `update` on Fabric. As well as the token check, it runs a small audit search and
  warns, rather than passing quietly, when it finds no Copilot interactions, or no records at all
  (audit logging probably off in Purview).
- **A Prerequisites row for audit ingestion.** It shows whether the app has the role, or whether
  you can grant it, and the last check's result.
- **Clearer 0-record data checks.** When the audit load finds nothing, the data check lists the
  likely causes in order, narrowed by the last audit check. It also says how to reload the days
  already read as empty once the cause is fixed: on Fabric, rename
  `Files/_audit_staging/_manifest.json` in the Lakehouse and run `run --backfill-days <n>`.
- **A brought app registration must be in this tenant.** The installer stops, and says who can fix
  it, when it finds only another tenant's app, or an app with no service principal that you can't
  create.
- **Sign in to Viva Insights first.** With Cowork credits from the Dataflow, the installer creates
  `AnalyticsHub_Cowork_Credits` early, asks you to sign it in, and checks the connections are saved
  before it deploys the notebooks and pipeline and runs the first load. No more coming back to the
  installer after configuring the connection in Fabric. You can still skip it and finish later.

**Known issue:** on Azure, **Uninstall** deletes the install's managed identity but leaves the roles
it was given outside the resource group, such as Reader on the management group and Cost Management
Reader on subscriptions. In the Azure portal, they then show as **Identity not found**. To remove
them, see [Remove the roles the installer gave](docs/UPDATE.md#remove-the-roles-the-installer-gave),
which lists them all. 0.6.7 has this too.

**Known issue:** on Azure, if you ran the installer again after the first install, **Uninstall**
deletes the install's resources one by one and leaves the resource group. Delete the group in the
Azure portal afterwards.

**Known issue:** on Azure, Dataverse doesn't let the installer delete Agent Evaluator's application
user for good, because the user owns its own user settings record. **Uninstall**, or unticking an
environment, leaves it deactivated with no role, so it can't sign in or read transcripts. The
installer says so, but the steps it prints name a filter that the Power Platform admin center's
**Users** page no longer has. The user is listed as Inactive under the environment's **Settings** >
**Users + permissions** > **Application users**; deleting it there hasn't been tested. Until it's
gone, ticking that environment again finds the user disabled, skips the environment's transcripts,
and says to enable it, which a soft-deleted user can't be.

**Known issue:** on Azure with private networking, **Uninstall** can fail to delete the resource
group, and the installer says `it's Succeeded`. Power BI can keep the gateway's subnet for up to
72 hours after the gateway has gone. Only the virtual network and network security group are left,
and they cost nothing. Run **Uninstall** again later. See
[Troubleshooting](docs/TROUBLESHOOTING.md#uninstall).

**Known issue:** on Azure with private networking, the installer can't give the jobs read on the
SharePoint drop folder's site, even for a Global administrator. The jobs can't read the files there
until a SharePoint or Global administrator makes that grant by hand, as described in
[Troubleshooting > Known issues > Azure](docs/TROUBLESHOOTING.md#azure).

**Known issue:** on Azure, in a browser, the app can show **Something went wrong** with `timed_out`
a day after you signed in. Clear the site's data for the app's address (or use an InPrivate window)
and sign in again. That workaround hasn't been tested yet.

**Known issue:** on Azure, the browser setup doesn't offer **Public endpoints** when an Azure Policy
keeps Azure SQL's public access off, even in a resource group that's exempt from it. To use Public
endpoints there, set up from a terminal: run `AnalyticsHubInstaller.exe install --target azure`,
answer yes to **Change the advanced settings?**, choose the exempt resource group, and under
**Networking** choose **Public endpoints**. Setup warns that the policy keeps public access off
and that the deployment would fail; with the exemption, it doesn't. A fix is planned.

**Known issue:** on Fabric, the tenant credits export (tenant by day) from the Power Platform admin
center loads with blank dates when its Usage Date has seconds and AM/PM (for example
`5/3/2026 12:00:00 AM`), so Credit consumption shows no tenant rows, and the load still reports
success. The agent and user exports aren't affected, and neither are credits loaded by the
**Analytics Hub - Copilot Studio credits** flow. Until it's fixed, use the flow, or, before you drop
the file in or upload it with the installer, re-save its Usage Date in the form `5/3/2026 0:00`
(month/day/year, 24-hour time). Re-saving it as `yyyy-MM-dd` doesn't help: that loads blank too. If
a file has already loaded with blank dates, remove it from the landing folder and delete those rows
before you load the corrected file. See [Troubleshooting](docs/TROUBLESHOOTING.md#runs-and-loads).

**Docs:**

- **Agent Evaluator: pick environments that save transcripts.** Copilot Studio doesn't save
  conversation transcripts in developer or Dataverse for Teams environments, so Agent Evaluator
  finds none there. The installer's [Agent Evaluator](installer/README.md#agent-evaluator) section,
  Prerequisites and Troubleshooting now say so.

## Analytics Hub installer 0.6.8-rc.2 (unreleased)

**Release candidate preparation only.** 0.6.8-rc.2 is not published, and 0.6.7 remains Latest. Its
tag, `installer-v0.6.8-rc.2`, drafts a pre-release, which `releases/latest` and the installer's
update check skip.

**What changed since 0.6.8-rc.1:** Agent Evaluator works on Azure, so every module now does. The
installer offers it and gives the jobs' managed identity access to the Copilot Studio transcripts,
the jobs read them into Azure SQL, and its model deploys as a third Power BI model. On Azure, a long
history loads and processes within the run job's memory and disk, and a reload of more history that
doesn't finish in one run carries on in the scheduled runs after it. The app's Executive summary no
longer says everyone has a department. Neither does Ask on Azure. On Azure, a chart whose query has
no rows shows its empty state, instead of replacing the whole app with an error. The Executive
summary opens with fewer queries, and several of the app's slowest queries are faster: the summary's
hours range is its own query, twelve of the ValueLens model's measures count their users in one
pass, the Adoption summary is two queries asked at once, and Leaderboards' share card shows the top
1%, 5% and 25% without the curve. On Azure, the web app reuses each user's Power BI and Graph tokens
for up to 10 minutes, and compresses what it sends. The details are below.

**Update an existing install:** once 0.6.8-rc.2 is published, run its pinned command, or open it
from its release page, and choose **Update**. On Azure, that redeploys with this version's images,
adds the Agent Evaluator tables (migration `V008`), and redeploys and reloads the ValueLens model
with the faster measures. The jobs' next run recomputes every month once. To turn on Agent
Evaluator, choose **Repair or change**, tick **Agent Evaluator** under **Data collection**, and pick
its environments under **Module connections**. On Fabric, Update redeploys and reloads the ValueLens
model with the faster measures, and updates and republishes the Ask data agent. Let it redeploy the
app too: the other changes are in the app. From 0.6.7, the 0.6.8-rc.1 notes below apply too.

**Open the ValueLens templates in Power BI Desktop June 2024 or later.** Earlier releases show
errors in most habit-stage visuals. The app, published reports and Desktop connected live to a
published model aren't affected.

**Azure, by hand:** [the guide](docs/MANUAL-INSTALL.md#azure) now sets each model's parameters again
after you publish it. Power BI Desktop puts the template's values back when Load fails, as it always
does there, which left the published model with no data source to set credentials for. The guide
also covers an Azure Policy that turns off public network access, a Publish that times out, and how
long Remove takes.

**Known issue:** on an Azure install done by hand, the browser's developer tools show 400 "Cannot
find table" errors. They're expected: the guide publishes the ValueLens template without the tables
the installer adds, so the parts of the app that need them stay off, as
[Azure, by hand](docs/MANUAL-INSTALL.md#azure) lists.

**App: the Executive summary no longer says everyone has a department.** Its count of the people
with a task who have one took in everyone once any org data was loaded, so it said everyone had
one and its low-coverage note never showed. Now the app gives no count, just where the department
comes from and how to fill the gaps; for another org attribute, such as office location, **What
needs attention** leaves the line out. The installer's data check still gives the real count, and
warns below 80%.

**Azure: the installer offers Agent Evaluator.** Tick **Agent Evaluator** on an Azure install and
pick the Power Platform environments whose Copilot Studio transcripts the jobs read, from the same
list as on Fabric. The jobs' managed identity reads them, so in each environment it has to be an
application user with the **Bot Transcript Viewer** role. The web app's registration gets no
Dataverse access. A new **Transcript access** step adds the managed identity through the Dataverse
Web API when you're a System Administrator of the environment. Otherwise it prints the Power Platform
admin center steps, which search for the managed identity by its client ID, not its name, and asks
whether to leave the environment out for now or whether it already has access. See
[Agent Evaluator](azure/README.md#agent-evaluator).

- **Refresh waits for a readable environment.** The model deploys, and the Agent Evaluation pages
  show, once the module is on with an environment, outside demo mode. The pages are empty until the
  jobs first read transcripts. The installer's refresh, the model's scheduled refresh and the jobs'
  refresh of `ae` wait until the managed identity can read one of the environments, and the schedule
  is off until then. `agentEvaluator` is in the jobs' `VALUELENS_MODULES` whenever the module is
  ticked, as on Fabric, but `VALUELENS_DATAVERSE_ENVIRONMENTS` lists the environments only once one
  can be read, so the jobs read and refresh nothing before then.
- **Taking it away removes only what the installer added.** Untick an environment or the module, or
  uninstall, and the installer takes away the role it gave and deletes the application user it
  created, deactivating it first. If Dataverse won't delete it, the installer activates it again,
  with no role, and prints the steps for a System Administrator. It leaves application users an
  admin added. Unticking the module keeps the model and its ID, hides the pages and turns off the
  schedule; ticking it again reuses the same model.
- **Demo mode** reads no transcripts, adds no access and hides the pages. Switching to it removes
  nothing, so the managed identity keeps its access for when you switch back.
- **`status`** shows how many environments the managed identity can read, and what the jobs' last
  read found in each.

**Update an existing Azure install:** run the installer, choose **Repair or change**, tick **Agent
Evaluator** under **Data collection**, and pick its environments under **Module connections**.

**Azure: the jobs can collect Agent Evaluator's data.** A new `agentEvaluator` jobs module reads
Copilot Studio conversation transcripts from Dataverse with the jobs' managed identity, parses them
as the Fabric notebook does, and publishes the seven Agent Evaluator tables to Azure SQL (migration
V008).

**Azure: the installer can deploy the Agent Evaluator model.** Like Consumption Central, it's the
Fabric template converted to read Azure SQL, deployed as a third Power BI model. It gets the same
credential or VNet gateway binding, refresh schedule, viewer access and org-scoped access, and the app
and the jobs' refresh see it as `ae`. Agent Variables and Conversation Transcripts (Raw) load empty, as
they do on Fabric.

**Ask on Azure no longer gives a count of the people with a department.** For the Executive
summary's figures it runs that page's query, whose count of the people with a department takes in
everyone once any org data is loaded, so an answer could say everyone has one. The web app's
`/api/ask` now leaves that count out of what its model reads; the query is unchanged. On Fabric,
Ask opens the Fabric data agent, which doesn't run that query.

**Azure: a long history processes within the run job's memory and disk.** In an offline test at
20,000 seats, processing 180 days of history spilled more than 40 GiB to disk and hadn't finished
after 46 minutes; the run job has 8 GiB of memory and about as much disk. It now takes 25 to 35
minutes, with at most 6.2 GiB of memory committed and 3.5 GiB spilled. A 30-day first run and a
nightly run take about 3 and 5 minutes.

- **In passes.** When the months to process hold more than 2 million audit rows, as a long backfill
  or a large tenant's full rebuild can, `process` curates them in passes of whole months, oldest
  first, and saves its progress after each one. A run that stops part-way carries on with the
  months left. See [Steps](azure/jobs/README.md#steps).
- **Less to hold.** `process` streams the rows it checks against changed conversations, updates
  only the conversations that reach months it keeps, and drops each step's tables once it's done
  with them.
- **A memory cap with room to spare.** The run job caps DuckDB at 5 GiB
  (`VALUELENS_DUCKDB_MEMORY_LIMIT`). At DuckDB's default of 80%, less than 1 GiB of the 8 was left
  spare.
- **The audit collector too.** Collecting those 180 days took 7.2 GiB of memory and 22 GiB of disk,
  and in the job, DuckDB's default spill folder isn't writable. The collector now stages each page
  of audit records gzip-compressed, merges more than 250,000 staged records in passes of whole
  days, oldest first, under the same cap and with a temp folder of its own, and then frees its
  local copy of the pages, so `process` has the disk. It now collects them in 18 minutes, with at
  most 2.2 GiB committed, nothing spilled and 2.5 GiB on disk, plus the time the audit queries wait
  in Microsoft's queue. Pages staged by an earlier version still merge. See
  [Steps](azure/jobs/README.md#steps).
- **A reload that runs out of time carries over.** Loading more history (**Repair or change** >
  *Load more audit history*, or `run --backfill-days`) sets `VALUELENS_AUDIT_BACKFILL_DAYS` on one
  run. If that run stopped at the job's 4 hours before merging, or a window failed, the next runs
  dropped what was left without an error, while the install record said the history was loaded. The
  run now records where the reload starts before it queries anything. Later runs plan from there
  and query only what's missing, until a run has merged it all. Agent Evaluator records the reload
  for each environment before any collector runs, and reads each one back that far until its read
  finishes. On Azure, the installer's reload question and note now say a run stops at 4 hours and
  the scheduled runs carry the reload on.
- **Query timings.** Each audit window's log line gives how long it waited for a query slot, how
  long its query took to be ready (and in how many polls), and how long its pages took to read. A
  summary follows the fetch, so a longer reload can be sized against the 4 hours.
- **After the upgrade.** The first run recomputes every month once, as after any change to the
  processing code. On a large tenant it runs in passes.

**App: Leaderboards shows the busiest 1%, 5% and 25% without the concentration curve.** The share
card now gives just those three callouts, and its query works out only those three cuts, so the
page's first view no longer waits for the curve. On an F64 trial with 20,000 people, on 0.6.8-rc.1,
the whole curve's query took 3.46–4.06 seconds and a callouts-only one 1.16–1.68 (measured). The
shares and their people counts are worked out as before, ties included. Consumption's Copilot
Studio section and Value keep their curves.

**Power BI model: faster agent, unlicensed, Cowork and habit-stage counts.** In both Fabric
templates, and so in the Azure model built from them, `[Active Agent Users]`,
`[Active Unlicensed Users]`, `[Cowork Users]` and `[Cowork Fit: Eligible Users]` now count their
users in one pass instead of testing each user, as in
[ValueLens #202](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/pull/202). The eight
habit-stage counts, `[Beginner Users, Last Month]`, `[Beginner Users (Monthly)]` and the same pairs
for Developing, Habitual and Power users, count everyone's active days at once, as in
[ValueLens #203](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/pull/203). Where user
IDs are filtered directly, all twelve still test each user. The numbers don't change. With these
measures defined in the query against 0.6.8-rc.1's model, with 20,000 people on an F64 trial, the
Executive summary's query took 2.44 s instead of 2.80 s, and the Adoption summary's 3.83–4.51 s
instead of 5.05–6.23 s. Running the installer again deploys the model with them; if you published a
template yourself, publish the new one.

- **Open the templates in Power BI Desktop June 2024 or later.** The habit-stage counts use
  `SUMMARIZECOLUMNS` inside a measure, and earlier Desktop releases show errors in most habit-stage
  visuals. The Power BI service and Fabric evaluate them for the app, published reports and Desktop
  connected live to a published model, so those aren't affected.

**Adoption: the summary is asked for in two queries.** The five sessions-per-user-per-week figures
have their own query now, and the other ten keep theirs. The app asks for both at once, on the
Adoption page and when it prefetches the page, on Fabric and on Azure, and fills the cards when both
have answered. While the filters change, the cards keep the figures they showed until then, as they
did before. Each figure is the same expression under the same filters, and the task times you set
still apply to the figures that read them, so the numbers don't change; tests check that offline.
Measured the same way as the model changes above, the two queries took 2.77 s together, against
3.93 s for the single query on its own. That run didn't compare the figures.

**App: the Executive summary's figures no longer wait for the hours range.** The Conservative to
Optimistic range under the bottom line's hours is now its own query, asked at the same time as
the summary and under the same filters, on Fabric and Azure. Measured on 0.6.8-rc.1 on an F64
trial with 20,000 people, the summary took 2.80 s, and 2.03 s without the range. Asked as a pair,
the two took 2.02 s and 1.68 s, or 1.65 s and 1.64 s against 2.44 s with the ValueLens model changes
above, and gave the same results as the single query. The bottom line shows the same
figures. The range shows a placeholder until it lands, appears only once it and the hours answer
for the same filters, and says so, with **Try again**, if it doesn't load. Downloads and report
packs wait for it, as they wait for any card still loading. Estimated: the first figures land
0.8 to 0.9 s sooner and a date change 0.5 to 1.0 s sooner, but until the landing asks fewer
queries, the page as a whole is ready about 0.2 s later.

- **Ask:** on Azure, `bottom_line` no longer returns the range; a new `hours_range` tool does. The
  Fabric data agent's instructions name it too, so the installer's next run updates and
  republishes the data agent.

**Azure: the web app reuses each user's Power BI token, and compresses what it sends.** It
exchanged the signed-in user's token for a new Power BI token on every query, and sent everything
uncompressed. Now one sign-in client serves the whole process, and each user's Power BI or Graph
token is reused for up to 10 minutes, and never past 5 minutes before it, or the user's own token,
expires: about one exchange per user every 10 minutes, not one per query. A user whose account is
disabled, or whose sessions are revoked in Entra, keeps Power BI and Graph access through the app for
up to 10 minutes, and can reopen results loaded in that time for up to 10 minutes after each was
fetched. Removing an app role or workspace access is delayed only as before: a role until
the user's sign-in token expires, and results they've already loaded for up to 10 minutes. Tokens
are kept under a SHA-256 of the user's token and the scopes, so one user's token never serves
another, at most 2,000 at a time, and they're never logged. Queries that arrive together share one
exchange, and a token Power BI or Graph refuses is dropped. Query results and other JSON of 1 KB or
more go out with Brotli or gzip, and the app's files, about 3 MB of start-up code, are compressed
once when the image is built. The 0.6.8 plan estimates that Azure pages are ready 0.2 to 2.3 s
sooner (est.); it hasn't been measured on Azure. Nothing changes on Fabric.

**App on Azure: a chart whose query has no rows shows its empty state.** In 0.6.7 and 0.6.8-rc.1,
on Azure, a chart whose query had no rows replaced the whole app with an error, the **Something went
wrong** screen. On Azure an answer with no rows names no columns, and five charts that show only
their largest categories looked up the column to rank by first: on Readiness, priority by
organization and Cowork readiness by organization; on Value, the task breakdown; and on Adoption,
activation by organization and the trend heatmap. With no rows they now rank nothing and show their
empty state, as they already did on Fabric, where an answer with no rows still names its columns.
Tests run an answer with no rows through the SDK's own parsing for each of the five, on Azure and
on Fabric.

**App: the Executive summary opens with fewer queries.** On Fabric and Azure, it now sends 8
queries as it opens, the hours range's among them, or 9 with org-scoped access, rather than 18. The
app runs at most four queries at a time, so the page's own queries wait behind fewer others. Its
figures don't change. The 0.6.8 plan estimates that the page is ready 1.4 to 1.7 s sooner on
0.6.8-rc.1's model with 20,000 people (est.).

- **Filter menus load their choices when first opened.** The org values, and Consumption Central's
  org attributes, load when a filter menu other than the dates first opens, so the org menu's first
  open can take about a second. Opened before the org columns have loaded, it also waits for them,
  up to about three seconds on a large tenant: it lists values only once it knows which column is in
  use. Consumption Central's org attributes also load once an org filter is set.
- **Group by appears a few seconds later.** The org columns now load in the background, and on screen as
  soon as a filter menu or a breakdown by org needs them. On a model whose `Organization` column is
  empty, the org filter takes the name of the column it falls back to once they load.
- **The org menu lists only the column in use.** After **Group by** changes the column, the org menu
  says its values are loading until the new column's arrive, rather than listing the last column's.
- **One query checks the optional sources.** It counts the rows in each of them at once. If it fails
  for any reason but a busy model, the app counts each source on its own, as before.
- **One query for the credits.** The summary's Copilot Studio and Cowork credits, for the trend's
  months and for the date range, now come in one query. They still wait for the dates.
- **The trend doesn't wait for the dates.** With no date filter, it finds its own six months and
  starts with the page's first queries. Like the summary and its hours range, it no longer waits for
  the task times saved in the app, and is asked again only if they differ.
- **Load status loads in the background**, and the app asks which orgs the viewer can see only when
  org-scoped access is on.
- **On Azure, the app is told when org-scoped access is on.** The web app's `/app.config.json` now
  passes on the org attribute that row-level security filters on, as the installer meant. So the app
  still asks which orgs the viewer can see there, and the Share panel offers scoped delegation, which
  the web app had left out until now.

## 2026-10-20 — Analytics Hub installer 0.6.8-rc.1 (pre-release)

**A pre-release, for testing.** 0.6.7 stays Latest, so the `releases/latest` links still serve it.
To install 0.6.8-rc.1, use
`irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.8-rc.1/install.ps1 | iex`.
Agent Evaluator on Azure isn't in this candidate; it comes in 0.6.8-rc.2.

**What changed:** on Azure, the Agent 365 registry, product feedback and Workday org data now
install from their exports, credit consumption is checked against Fabric, the app skips the checks
for modules that are off, and an install can use a resource group your Azure admin creates, with
least privilege. Azure setup sizes for tenants with more than 10,000 Copilot seats, and the
installer fixes what the 0.6.7 Azure test found. In the model, active-user counts are faster and a
Workday `Department` column no longer fails the refresh. The app's first pages load sooner. On
Fabric, the app shows saved task times, report packs and commercial terms again: check your terms
after updating. Azure by hand, in Azure Cloud Shell, is documented; it works once a release that
includes it is Latest. The details are below.

**Update an existing install:** run the pinned command, or open installer 0.6.8-rc.1 and choose
**Update**. On Azure, that redeploys with this version's images, adds the Agent 365 and
product feedback tables (migrations `V009` and `V010`), and redeploys any model whose definition
changed. On Fabric, it redeploys the model and notebooks, and offers to replace the pipeline and
redeploy the app. To turn on a module Azure now supports, choose **Repair or change**, then **Data
collection**. Workday org data is under the advanced settings: see
[Workday org data](azure/README.md#workday-org-data). Some Azure installs that ticked **Credit
consumption** before 0.6.8 keep Copilot Studio and Cowork left out until you pick their sources:
see below.

**Azure: set it up by hand, without the installer.**

- **Seven steps in Azure Cloud Shell**, plus Teams if you want it, from the installer's own
  template, images and report. See [Azure, by hand](docs/MANUAL-INSTALL.md#azure).
- **Two files for it.** `azure/infra/main.bicepparam` is now the by-hand settings file: you copy it
  and the steps fill it in. `azure/infra/web-app-registration.json` is the web app's registration.
  A test keeps the registration and the page's Graph roles in step with the installer, and CI
  builds the settings file against the template.
- **What you don't get** by hand, such as **Check status**, **Repair or change**, update checks
  and org-scoped access, is listed on the page.
- **Only from a published release.** **Get the files** uses the latest release once it includes
  Azure by hand and its images are published. Until then, it says **Not available yet**. If git
  can't get the files, it stops there.
- **Saves before it makes.** Step 1 saves where it deploys, then deploys. Steps 2 and 4 save each
  app and the workspace before setting them up. If a save fails, the step says **Not saved** and
  stops, so `my.bicepparam` keeps what Remove needs. Step 1 won't deploy somewhere else with the
  same `my.bicepparam`.
- **A whole record, or none.** `main.bicepparam` now ends with a line that shows a copy is whole.
  **Get the files** makes `my.bicepparam` whole or not at all, and won't use one without that line.
  It says how to move it aside instead.
- **Remove** deletes only in the tenant, subscription and resource group that step 1 recorded: if
  you're signed in somewhere else, it says how to sign in and deletes nothing. It keeps each ID
  until that delete succeeds, and `my.bicepparam` until the resource group is gone, so you can
  paste it again.
- **Tenant settings.** [Prerequisites](docs/PREREQUISITES.md#fabric-admin-about-5-minutes) now
  lists three for Azure, not two, and who needs each one if it's only on for some groups.

The installer and Fabric by hand are unchanged.

**Azure: the Agent 365 registry, from its CSV export.** The `agent365` module now installs on
Azure. Drop the Microsoft 365 admin center's export in `agent365/` in the `landing` container, or
with private networking in the SharePoint drop folder's `agent365` folder. Each run loads the newest
one into `dbo.agents_365` (migration `V009`), the table Fabric fills, so the same pages work. The
Agent 365 API is Fabric only for now: `--data agent365=api` warns and uses the export. See
[Agent 365 registry](azure/README.md#agent-365-registry).

**Azure: product feedback, from its CSV exports.** The `productFeedback` module now installs on
Azure. Drop the Microsoft 365 admin center's exports in `product_feedback/`, in the same places as
the Agent 365 export. Each run loads them all into `dbo.user_feedback` (migration `V010`), the table
Fabric fills, with duplicates removed by Feedback Id. The emailed export flow is Fabric only for
now: `--data productFeedback=flow` and `--feedback-flow` warn and use the exports. See
[Product feedback](azure/README.md#product-feedback).

**Azure: Workday org data, from its CSV export.** Workday now installs on Azure too, with org data,
under the advanced settings or with `--data workday=csv`. Drop the Workday export in `workday/`, in
the same places as the Agent 365 export. After each Entra ID load, each run adds the newest one's
columns to `dbo.copilot_org_data`, matched on Primary Work Email, with the Fabric notebook's rules
and checks. See [Workday org data](azure/README.md#workday-org-data).

**Azure: the app skips the checks for modules that are off.** The web app now gets
`VALUELENS_MODULES`, the list of modules the installer turned on, which only the jobs had before,
and serves it in `/app.config.json` as `modules`, as `fabric.config.json` does on Fabric. When it
opens, the app no longer runs those modules' checks (up to five small queries, and Governance's
Resource Graph summary), and Governance says the Agent 365 registry or Defender isn't turned on,
instead of how to connect it. The data doesn't change: an off module's tables were already empty,
so its pages were already hidden. An Azure install gets this at its next **Update** or **Repair or
change**; until then the app checks every source, as before. See [web](azure/web/README.md#routes).

**Power BI model: faster active-user counts.** In both Fabric templates, and so in the Azure model
built from them, `[All Active Users]` and `[Active Licensed Users]` now take one distinct count
instead of testing each user, as in
[ValueLens #199](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/pull/199). Adoption
and the Executive summary should load sooner. The numbers don't change.

**Power BI model: a Workday `Department` column no longer fails the refresh.** The org query
renamed `Department` to `Organization` even when the org data already had an `Organization`
column, so a Workday export with a `Department` column failed the refresh. Now it renames
`Department` only when there's no `Organization` column, and leaves `Organization` as it is: a
blank one isn't filled in from `Department`. The fix is in both Fabric templates and the Agent
Evaluator template, and so in the Azure model built from them.

**Workday org data only adds columns, and the wording now says so.** The installer said it adds or
overrides org fields, and the installer, the org data load, the app and the docs suggested it when
few people have a department. It only adds the columns the org data doesn't have, so it doesn't
fill in a missing department. The advice now just says to fill in Department in Microsoft Entra ID.

**Azure: sizing for a tenant with more than 10,000 Copilot seats.** Smaller tenants are asked
nothing new and deploy as before.

- **Power BI capacity.** Setup recommends F64 or larger, suggests the first active capacity that
  size, and warns when the semantic model would sit on shared capacity, where a model is limited
  to 1 GB.
- **Paid options, off unless chosen.** **Azure placement** offers Azure SQL that scales up to 4
  vCores and carries on past the free offer's monthly allowance (about $30-80 a month), and a web
  app that keeps one replica running (about $10-20 a month). `--yes` never turns them on, and
  **Repair or change** keeps what was chosen. The ARM template takes a new
  `sqlFreeLimitExhaustionBehavior` parameter, `AutoPause` by default.
- **First load.** A new test checks that an audit collection cut off by the run job's 4-hour limit
  carries on in the next run. The [installer README](installer/README.md#a-large-tenant-on-azure)
  says what to expect at 20,000 seats.

**Installer: fixes from the 0.6.7 Azure test, and release candidates.**

- **A connection Fabric made while throttling is reused.** When Fabric answered the request for
  the model's connection with 429 (too many requests) but made the connection anyway, the retry got
  409 `DuplicateConnectionName` and the step failed until you chose **Retry**. Now the installer
  finds the connection by name, reuses it and sets its credentials, on Fabric and on Azure. With
  private networking on Azure, it reuses only a connection on the install's own gateway.
- **Uninstall soon after publishing keeps track of the Teams app.** Microsoft Graph can take half an
  hour or more to find an app the installer has just published to your org's app catalog. Before,
  an Azure uninstall in that time took "not found" to mean the app was gone and forgot it, which
  left the app in the catalog. Now, for a day after it publishes or updates the app, the installer
  keeps its record and says how to delete the app in the Teams admin center.
- **Azure uninstall deletes the Power BI workspace it created.** It used to leave the workspace, and
  the semantic models in it, behind. Now it asks first, and the answer defaults to yes, so `--yes`
  deletes it too. It never offers to delete a workspace you picked rather than had it create, or
  one you've renamed since: it leaves those for you.
- **Azure uninstall says a resource group is deleted only once it's gone.** It said "Deleted
  resource group" as soon as Azure accepted the delete, which can take half an hour more to finish.
  Now it waits up to 45 minutes for the group to go. If Azure is still deleting it then, it says
  so; if Azure stopped, it gives the group's state and the uninstall fails. With `--no-wait`, it
  stops once Azure accepts the delete and says that's what happened.
- **The installer exe waits for antivirus rather than failing to start.** The exe unpacks to a new
  folder, then renames it into place. Antivirus checking the new files can hold that folder for a
  moment, and the exe tried the rename once and handled only one of the two errors Windows gives,
  so "Access to the path … is denied" ended in "The installer couldn't start" until you ran it
  again. Now it tries again for up to 50 seconds on either error, and stops as soon as another
  copy has finished unpacking. If the folder is still held, it asks you to wait a minute and run
  it again.
- **Release candidates.** A version such as `0.6.8-rc.1` now builds: its `installer-v0.6.8-rc.1`
  tag drafts a pre-release, whose notes say it's a release candidate and pin its own `install.ps1`.
  `releases/latest` and the installer's update check skip it, and its Azure images are tagged with
  that version, so they don't replace a release's. Before, the release notes step took only x.y.z,
  so the tag's build and the signing pipeline failed. The Teams app inside has the release's
  version, `0.6.8`, because Teams takes only x.y.z.

**App and README:** both credit their creator, "Created by Keith McGrane", linked to his profile.
In the app it's a small footer at the bottom of the sidebar, so it's on every page, in a browser
and in Teams, Outlook and Microsoft 365.

**Azure: least-privilege install into a resource group your Azure admin creates.** The admin
creates the group, registers the resource providers, and gives you Contributor and a Role Based
Access Control Administrator that's limited to the roles the installer gives, on just that group
([Least-privilege Azure install](docs/AZURE-LEAST-PRIVILEGE.md)). Owner, or Contributor and User
Access Administrator, still works as before.

- **Checks the resource group.** With an existing resource group, **Checking Azure** and
  **Prerequisites** check your rights there, not just on the subscription, and the preflight stops
  before creating anything when you can't deploy or assign roles there.
- **Commands for the admin.** During **Checking Azure**, resource providers you can't register, and
  the managed identity's roles outside the group (Azure AI and pay-as-you-go costs, Reader for
  Resource Graph), are listed as az commands for your Azure admin. Deployment errors about
  unregistered providers or role assignments say what's needed.

**Docs:**

- **A shorter README, by path.** The [README](README.md) is now just the steps for Path 1 (Fabric)
  and Path 2 (Azure), with the installer or by hand. Each path also has a folder of just its steps,
  [1-fabric](1-fabric/) and [2-azure](2-azure/). The code stays in `fabric/` and `azure/`. What you
  get, the data and the list of pages moved to [docs](docs/README.md). Old links and anchors still
  work. The exe download is a plain link now, after the PowerShell command.
  [Install](docs/INSTALL.md) now names the installer's first choice as it appears:
  **Microsoft Fabric**.
- The installer README lists Defender with the modules Azure supports.

**App: Adoption now comes straight after the Executive summary, ahead of Value, Consumption and
Efficiency.**

**App: background loading can't stay paused after a throttle.** It still waits at least a minute,
and until a query on screen to that model succeeds, but now for at most five minutes after the
model's last throttle. Then it tries the model again, one query at a time. Before, it could wait for
good if nothing on screen asked that model, and pages stopped loading ahead for every model.

**App: on Fabric, the first query starts a round trip sooner.** The app now asks for its three
config files at once, rather than ruling out an Azure config before it asks for the Fabric ones.
Azure installs load their config as before.

**Azure: credit consumption checked against Fabric.**

- **Recommended sources on a new tick.** Ticking **Credit consumption** on Azure now starts from the
  Copilot Studio credits flow and the Cowork CSV export. Before, both defaulted to left out.
- **Installs that ticked it before 0.6.8.** If an Azure install ticked it without changing the advanced
  settings and reads Azure AI from a subscription, Copilot Studio and Cowork stay left out, because its
  record can't tell that from a choice. To turn them on, choose **Repair or change**, then **Module
  connections**, and pick their sources. In a terminal, run `install` and say **Yes** to the advanced settings.
- **`--data azureAi=skip` works on Azure.** The subscription question now defaults to leaving Azure AI
  out, as it already did after **Leave Azure AI out**, so `--yes` no longer turns it on.
- **Clear errors for Fabric-only options.** On Azure, `upload`, `install --csv` and `load-cowork` now
  stop and name the folder to put exports in. `coworkCredits=api`, `--flow-identity app` and leaving
  every credit source out warn.
- **Unticking it works as on Fabric.** On Azure, unticking **Credit consumption**, or switching to demo
  mode, keeps the Consumption Central model but hides its pages in the app. The jobs, the `refresh`
  command and its scheduled refresh in Power BI stop refreshing it, and the installer stops giving access
  to it. Ticking it again reuses the model. Before, the app kept the pages, with data that no longer updated.
- **Parity documented.** The [Azure README](azure/README.md#parity-with-fabric) compares credit
  consumption with Fabric source by source, says why the Viva Insights Dataflow, `--flow-identity app`
  and installer uploads are Fabric only for now, and gives the steps to compare the two Consumption
  Central models with `parity.mjs`.

**App: start-up code now downloads while the config loads.** The page now tells the browser to
fetch the code for the app, and for the Executive summary it opens on, straight away. Before, the
app asked for that code only after its config arrived. The code still runs only after that. Each
build takes the list from its own imports, so the list keeps up as the code changes.

**App: the Executive summary's headline figures no longer wait for the task times saved in the
app.** They're asked with the page's first query, and asked again only if saved times change them.

**App: a quicker Executive summary.** It now counts the agents in use, and the people with an
organization, all at once rather than one agent or person at a time. The figures, and what the
Fabric data agent is told about them, don't change.

**App: on Fabric, saved task times, report packs and commercial terms show again.** In 0.6.7 and
earlier, the app on Fabric read back only each saved row's id. So task times saved in the app never
applied, even straight after saving. Report packs, rates, budgets and prices looked saved until the
page reloaded, then showed as unset. The app now asks for every column it uses, and after saving one
terms menu, the terms set in the others keep showing. Azure installs weren't affected.

- **Check your terms after updating.** While terms showed as unset, each menu's boxes were empty,
  and **Rates & packs**, **Monthly budgets** and **Prices** save every box in the menu. So saving one
  term cleared the others in the same menu, and they stay cleared.
- **Report packs created twice.** A pack created again while the list looked empty now shows beside
  the original. Delete the one you don't need.

## 2026-10-19 — Analytics Hub installer 0.6.7

**The current release.** 0.6.7 replaces 0.6.6 as Latest, so the `releases/latest` links, including
the PowerShell command, now serve it. To pin this version, use
`irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.7/install.ps1 | iex`.

**What changed:** clean-PC installer fixes preserve concurrent app deployments and report failed
steps accurately. Azure adds personal-tab support in Outlook and the Microsoft 365 Copilot app,
plus optional Teams org app-catalog publication. Value, Consumption and Efficiency follow the
Executive summary, which now opens sooner. Simpler docs are included below.

**Update an existing install:** run the PowerShell command again, or open installer 0.6.7 and
choose **Repair or change**. Azure app-catalog publication needs an additional sign-in with the
admin role and consent described below; you can continue without it and upload the package by
hand. Pinning the app in Teams remains manual. 0.6.7 adds no new schema migration or model-reset
requirement. The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.6.7`.

**Azure: the Teams tab also opens in Outlook and the Microsoft 365 Copilot app.**

- **Same sign-in.** The installer pre-authorises the Outlook and Microsoft 365 app clients (web,
  desktop and mobile) on the web app's registration, next to Teams, and the web app lets
  `*.microsoft365.com` and `outlook.office365.com` show it in a frame.
- **Keeps what an admin added.** An upgrade or Repair now keeps any other pre-authorised client or
  scope on the web app's registration, and adds its own. Before, it put back only its own.
- **Signs in as it opens.** On the tab's address, the app now initialises TeamsJS and asks the host
  for a token, so people go straight to their data. If the host needs a prompt first, such as consent
  or MFA, the tab shows **Sign in with Microsoft**, which opens it in a pop-up. Before, sign-in in
  the tab failed with "The library has not yet been initialized", in Teams too.
- **Keeps loading in Outlook on the web.** The tab reuses its token rather than ask for one per query.
- **No wait in a browser.** The app starts TeamsJS only on the tab's address. Before, a browser
  window that another app opened could stay blank for up to a minute.
- **Personal tab only.** The channel and group chat tab stays in Teams.
- **A new Teams package.** Its accent colour now starts with `#`, as the schema requires. Upload
  `AnalyticsHub-Teams.zip` again, or let **Repair or change** republish it to the org catalog.

Existing Azure installs get this on their next upgrade or **Repair or change**. Fabric is unchanged.

**App: Value, Consumption and Efficiency now come straight after the Executive summary.**

**App: the Executive summary opens sooner.**

On F64 with 20,000 synthetic people and the model warm, the page was ready about 5 seconds after
its first query, down from about 12 (medians of 6 test opens each).

- **Its two slowest queries start sooner.** The summary and the monthly trend now start ahead of
  other waiting queries. The pacing is unchanged: at most 4 queries in flight and 90 a minute.
- **A quicker trend and summary.** The trend counts each month's active people once, and works out
  the seat counts once rather than for every month. The summary counts the seats in use once.
  Neither tests every user ID each time any more. The figures, and what the Fabric data agent is
  told about them, don't change.

**Azure: the installer publishes the Teams app to your org's app catalog.**

- **No upload by hand.** After it writes `AnalyticsHub-Teams.zip`, the installer publishes it to
  your org's app catalog through Microsoft Graph. A few hours later, people find Analytics Hub in
  Teams under **Apps** > **Built for your org**, and in Outlook and the Microsoft 365 Copilot app.
- **The catalog accepts the package.** Its accent colour is now `#6264A7`, as the Teams manifest
  schema requires. Before, it had no `#`, so Microsoft Graph turned the package down with a 400
  ("Schema validation failed at 'accentColor'") and the app never reached the catalog. A test now
  checks the package against the schema.
- **Updates the same app.** A re-run, **Repair or change**, **Update** or an upgrade updates the app
  already in the catalog, including one uploaded by hand, rather than add another. If the package
  hasn't changed, it leaves the app alone.
- **One more sign-in.** Publishing takes the Teams Administrator or Global Administrator role and
  consent to `AppCatalog.ReadWrite.All`, which the Azure CLI's sign-in can't ask for. So the
  installer signs in once more, as Microsoft Graph Command Line Tools, at the start of the install
  rather than at the end. The plan asks first, and you can go ahead without it. If the sign-in isn't
  finished within 5 minutes, the install carries on without it. With `--use-az`, it doesn't publish.
  The consent stays until an admin revokes it: see
  [Permissions](docs/PERMISSIONS.md#publishing-the-teams-app-path-2).
- **Falls back to the steps.** If it can't publish, because of the role, consent, a tenant policy, an
  error or a sign-in nobody finishes, the install carries on. It keeps the zip, prints the steps to
  upload it by hand, and **Check status** shows them as a pending admin action, which a later run
  clears once the app is in the catalog. If Teams turns down an update at the same version, the steps
  stay pending and the next run tries again.
- **Uninstall removes it.** Uninstall deletes the app the installer looks after: the one it
  published, or a hand upload it took on. It leaves any other alone.
- **Pinning stays manual.** Microsoft Graph can't change app setup policies, so a Teams admin pins
  it for the viewers group. See [Give it to everyone](azure/teams/README.md#give-it-to-everyone).

Existing Azure installs get this on their next upgrade, **Repair or change** or **Update**. Fabric
is unchanged.

**Installer: fixes from a clean-PC test of 0.6.6.**

- **An app deployed while an install runs stays in the install record.** When the app step fails,
  the installer says to run `deploy-app`. An install still waiting on its first load then saved
  the record from the copy it read at the start, which dropped the app: `status` didn't show it,
  and repair or update didn't treat it as deployed. Each save now keeps what another command
  changed since, field by field. The install's summary counts an app deployed meanwhile when the
  app step was the only one that failed.
- **A step that fails leaves the install "partly set up".** Before, an install could end "Analytics
  Hub is set up", and exit 0, after a step failed (✗) and it carried on: a Power BI report, the Ask
  data agent, an upload, org-scoped access, the data check after the first load, or a source that
  failed to load in a pipeline run that still completed (except the Cowork credits Dataflow while
  signing it in is still to do, which is a next step). Now any of those ends it "partly set up":
  the installer exits 1, and its page shows the install didn't finish. On Azure, org-scoped access
  or a history reload that doesn't start ends it "set up, but not finished", also with exit 1. Each
  failed step says how to try it again. A step that only warns (⚠), or works when it's tried
  again, still ends "set up", unless a load or refresh the installer waited for hasn't finished, as
  before. `update` says it isn't finished, instead of "Up to date", after a step that failed.
- **The summary says how to deploy the app.** When the app step fails, the "partly set up"
  summary's next steps now start with fixing the problem and running `deploy-app`, or choosing
  **Redeploy the app**.
- **A step that fails shows as failed** on the installer's page, not done, when the install carries
  on past it: a step with a ✗ line, or the first load or a history reload with a source that failed
  to load, counted as above. The page then offers **Rerun failed**, also for the Cowork credits
  Dataflow on a busy capacity, which it showed as waiting for its sign-in.
- **Governance and flows says "Resource Graph: off"** when that source is skipped, or on Azure's
  demo data, instead of "agents on, Foundry on".
- **Run it from a desktop session.** Over SSH, for example, the app's deploy tool may not be able
  to store its sign-in securely, so a Fabric install sets up everything except the app. See
  [Known issues](docs/KNOWN-ISSUES.md#installing).

**Simpler docs.** The README shows Fabric and Azure side by side, with short steps for each. Verify,
Uninstall and Known issues moved into Install, Update and Troubleshooting, and the old links still
work.

## 2026-10-17 — Analytics Hub installer 0.6.6 (pre-release)

**A pre-release, for testing.** 0.6.5 stays Latest, so the `releases/latest` links still serve it.
To install 0.6.6, use
`irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.6/install.ps1 | iex`.

**What changed:** the app shows less on each page and paces its queries so it stays quick for a
large tenant, the install is sized by Copilot seats, daily processing handles only new days, and
an install that stops part way picks up where it left off on the next run.

**Power BI is busy:** a throttled card retries for up to a minute, and if it still shows busy it
loads again by itself once that model answers. Other models carry on.

**Update an existing install:** run the pinned command, or open installer 0.6.6 and choose
**Repair or change**. Unlike 0.6.3 to 0.6.5, this release changes what the installer deploys:

- The models now import columns the processor writes. The update asks before Fabric clears a
  model's data (`--allow-model-reset` for unattended runs), then reloads it. Reports on it show no
  data until that reload finishes.
- The next pipeline run rebuilds the curated audit fact once and fills the new columns, so it takes
  longer than usual. Until it finishes, those columns are empty.
- On Azure, migration `V007` adds the columns. The tag also publishes the `valuelens-jobs` and
  `valuelens-web` images as `0.6.6`.

**App: less on each page, so it stays quick for a large tenant.**

Measured on F64 with 20,000 synthetic people, the slowest queries took 13 to 20 seconds each and
opening the app took about 40 seconds.

- **One tab at a time.** Each page shows one section at a time, as tabs, and runs only the open
  tab's queries. The result cache holds 1,000 results instead of 64, each for up to an hour,
  so a page you've visited opens again without asking the model.
- **Slowest cards removed.** The executive summary no longer shows kinds of work per person, broad
  users or the agent with most users. The agent return rate is gone from Adoption and the
  Leaderboards agents, and the Leaderboards summary drops the agent with most users and the top
  Agent Builder creator and asks only for the group on screen. The sentence under the Activation
  cards, which repeated their figures, is gone.
- **Long lists wait for a click.** The leaderboard ranking, activation by organization, Cowork
  readiness by organization and its candidates, value by organization, Cowork fit by person and
  Cowork credits by group load on **Show …**. The cards above them still count everyone, and
  downloads and report packs still print them.
- **Other pages load in the background** after the page on screen has loaded, one query at a
  time, so their first view is usually ready. Opening a page starts its waiting query at once.
- **No per-person Group by** on Cowork and Copilot Studio credits. User, User Key, id, employee Id,
  Hierarchy Path and Level5_User Key took 73 to 148 seconds each. A saved choice falls back to All
  users.
- **Large figures fit.** A figure of a million or more reads 5.9M, with the exact figure on hover
  and for screen readers, and shrinks to fit its card. Hours of a thousand or more drop the
  decimal. Chart axes and totals are compact too.
- **Long charts show the top 15.** Activation by organization, task breakdown and the cost vs
  value agents draw the top 15 and one Other bar. Rate charts keep the 15 largest and say so.
- **Clearer at scale.** Capped lists say they are capped, more than two tied agents read "N agents
  tie", the agent name column is wider, and two long captions are shorter.

**App: queries paced so a busy Power BI doesn't empty a page.**

- **Paced queries.** The app now keeps at most 4 semantic model queries in flight and starts
  no more than 90 a minute per user, under Power BI's limit of 120. A page load used to send
  about 25 queries at once.
- **Retries.** A query that Power BI throttles is retried with jittered backoff (1, 2, 4, 8,
  then 15 seconds), for up to a minute in all. A `Retry-After` is kept in full: if it asks for
  longer than the query can still wait, the card shows busy at once, and nothing goes to that
  model until it ends. That includes a throttle sent inside a normal HTTP 200 reply, as an error
  table, which the app used to keep in its cache. Only the throttled model waits, and it gets one
  query at a time until it answers; queries to other models carry on. Other query errors aren't
  retried, even when they name a table such as `Rate Limit`. On Azure, the app now reads the
  `Retry-After` header that the web proxy passes through.
- **Closed cards stop asking.** When you leave a card, its waiting and retries stop. A query
  already sent still finishes, and its answer is kept.
- **Shared requests.** Identical queries that are in flight at the same time share one
  request.
- **A clear message.** A query that is still throttled after a minute shows **Power BI is
  busy** with a Try again button, not "This didn't load". Try again asks Power BI, not the cache.
  A query error that only quotes those words, as a name, shows as that error.
- **Busy cards clear by themselves.** Once the model answers any query again, every card that
  showed busy on it, and the filter choices, ask again with no click or page change, even if
  the answer came as the card gave up, or the card shares its query with others. A page opened
  after a throttle sends its queries instead of giving up at once. A card that has switched
  query or model, or closed, ignores what its old query reports.
- **Background loading pauses.** After a throttle, background loading from that model waits at
  least a minute, and until a query to it on screen succeeds. Pages still load when you open them.
- **Only the affected visual fails.** A throttled slicer-options query no longer replaces the
  whole Agent Evaluation or Consumption page with a "didn't answer" error. The busy notice sits
  above the stages and each stage loads on its own. On the Executive summary, Try again now
  reloads the dates.

**Sizing for a large tenant.**

- **The tenant size follows the Copilot seats as well as the capacity.** The prerequisite checks
  now report how many Microsoft 365 Copilot seats are assigned, and the plan shows them. A new
  install, or one with no size saved, is sized **More than 10,000** when more than 10,000 seats are
  assigned, as well as on F64 or larger. A trial capacity counts as the F size it matches, so an
  FTL64 trial is sized large however few seats are assigned, and an FTL4 isn't. An install that
  already has a size keeps it; the plan
  warns when the seats have outgrown it and says which step changes it. If the seats can't be read,
  sizing falls back to the capacity as before.
- **Capacity warnings.** With 30,000 or more seats on a capacity below F64, the plan says to choose
  an F64 or larger capacity in Fabric placement, or ask your capacity admin, and that setup still
  works if policy keeps you on the smaller one. `--yes` installs print the same warnings and carry on.
- **Azure sizing warnings.** On the Azure target, a tenant with more than 10,000 seats is warned
  about the Azure SQL free offer's monthly limit, fewer than 4 max vCores (from 30,000 seats), the
  run job's 4 hours per run, and a Power BI workspace on shared capacity, each with where to change
  it. Nothing is resized for you.
- **Longer time limits for the slow loads.** The Agent 365 registry (2 hours in the template, which a
  large tenant ran out of) now gets 3 hours, or 6 hours with a second retry for more than 10,000.
  Copilot Studio transcripts get 3 or 6 hours, and Defender 1 or 2 hours. **Update** and **Repair or
  change** rebuild the pipeline with them and keep your data and settings. An install from before
  tenant sizes keeps the template's limits until it's given a size.
- **The Agent 365 registry's weekly refresh is spread across the week.** Each agent now has its own
  refresh day, from a hash of its ID, so a run re-reads about a seventh of the agents rather than
  every agent on the same day. New and changed agents are read first. A new `TIME_BUDGET_MIN`
  (default 75 minutes; 120, or 270 for more than 10,000, from the installer) stops starting
  scheduled refreshes when it runs out and leaves the rest to the next run; the 7-day ceiling still
  applies.

**Daily processing handles only new days, so its cost no longer grows with history.**

- **The audit processor is incremental.** `copilot_interactions_curated` is now stored by
  `MonthStart`. With `WRITE_MODE = "merge"` (the scheduled pipeline's mode) the processor keeps
  a fingerprint of each month's source rows and recomputes only the months that changed, plus
  the months within `INCREMENTAL_LOOKBACK_DAYS` (default 14) of the newest record, so audit
  records that arrive late are still picked up. It replaces only those months
  (`replaceWhere`). A recomputed month is rebuilt from all of its source rows, so it equals a
  full rebuild, and the table's columns don't change.
- **Full rebuilds.** `WRITE_MODE = "overwrite"` still rebuilds everything. The processor also
  rebuilds everything by itself when its settings, its logic (`PROCESSOR_LOGIC_VERSION`) or the
  source schema change, and on the first `"merge"` run against a table that isn't stored by
  month yet. That run is the one-time migration for existing installs, and needs no action.
- **Known limitation.** Months that aren't recomputed keep the licence and agent-registry values
  from when they were last processed. Run `"overwrite"` once to refresh them, for example after
  a large licence change.
- **One slow step is fixed.** `Agent Last Used Date` was computed with a window over every row
  grouped by agent name, so every row without an agent, which is most of them, went to a single
  Spark task. It is now an aggregate joined back, with the same values.
- **The audit ingester stores `copilot_interactions_parsed` by month**, and its daily MERGE
  reads only the months in the batch instead of the whole table. On its first merge run, an
  existing unpartitioned table is rewritten by month once.
- **Azure.** `process` works the same way. The curated fact is now one file per month
  (`curated/copilot_interactions_curated/month-YYYYMM.parquet`, `month-none` for rows without a
  date), and the old `part-0.parquet` is removed by the first run. Force a full rebuild with
  `process --full-rebuild` or `VALUELENS_PROCESS_FULL_REBUILD=true`. The lookback is
  `VALUELENS_PROCESS_LOOKBACK_DAYS` (default 14), and `VALUELENS_DUCKDB_MEMORY_LIMIT` caps
  DuckDB's memory. Publish to Azure SQL already rewrote only the days that changed, so it's
  unchanged.

**The Agent Evaluator reads transcripts with bounded memory.**

- **Transcripts no longer sit in driver memory.** Each page from Dataverse is written as it
  arrives to JSONL files under `TRANSCRIPT_STAGING_DIR` (default `Files/_transcript_staging`),
  and Spark reads them back. The parse runs inside Spark tasks, `PARSE_CHUNK_ROWS` (default
  200) transcripts at a time, and every table is written in one Spark write.
  `PANDAS_TO_SPARK_CHUNK_ROWS` and `RAW_TABLE_CHUNK_ROWS` are gone. The staging folder is
  cleared at the start of each run and after a successful write.
- **Small format differences in the `agent_*` tables.** Whole numbers no longer end in `.0`.
  The raw table's bot lookup column holds JSON instead of a Python representation. Empty tables
  from a multi-environment run now include `source_environment`. An agent's catalogue name comes
  from its latest session. A MERGE source with duplicate keys keeps one row per key. Run messages
  say `writes=` instead of `chunks=`.
- **One unreadable environment no longer fails the run.** If one environment refused access
  and the others had no transcripts, the run stopped with *All window pulls failed* before it
  recorded the refusal in `evaluator_status`. It now stops only when every window pull fails.
- There is no transcript collector on Azure, so nothing changes there.

**Installer robustness ([#88](https://github.com/microsoft/AnalyticsHub-Dashboard/issues/88)).**

- **The first load is recorded as complete only once it's proven.** A first load whose pipeline
  run succeeded but whose audit load didn't is now recorded as `Incomplete`, not `Completed`, so
  the next run offers it again. `status` applies the same check when it syncs the record.
- **"Partly set up" instead of "ready".** If the app deploy or a waited-for first load didn't
  finish, the summary says Analytics Hub is partly set up, says to fix what's above and run the
  installer again, and the installer exits non-zero.
- **The install record is read back after it's saved**, and the installer stops with a clear
  message if it doesn't match (a read-only or full folder), like the save retry in 0.6.5.
- **Device policy that blocks `node.exe`.** When AppLocker or App Control blocks the Node.js the
  installer runs, `install.ps1` and the exe now say what to do: install the x64 LTS Node.js from
  your IT team (for example from Company Portal) and re-run with
  `$env:ANALYTICS_HUB_USE_INSTALLED_NODE = '1'`, or use Azure Cloud Shell, or ask your IT team.
  The launcher's cleanup falls back to `Remove-Item` when it can't run `node.exe`.
- **A pinned `install.ps1` whose release has gone** now says that `installer-vX` is no longer
  available and prints the `releases/latest` command to run instead, then exits non-zero. It
  doesn't switch versions on its own. Other download failures keep the proxy advice.
- **Unpacking survives a busy antivirus scan.** On Windows, `install.ps1` now retries moving the
  freshly unpacked installer into place for up to 20 seconds when antivirus still holds the
  files. If it still can't, it removes the half-unpacked folder and says to run the command
  again, not a bare "Access denied".
- **A run stopped part-way no longer leaves a second copy behind.** If the installer was closed
  while Fabric was creating a notebook, the pipeline, a model, a report, the data agent, the
  Dataflow or the app, the next run made a `_2` copy beside the first and left the first, with its
  client secret, outside the install. The installer now saves each item's name and a one-off
  reference before creating it, and writes the reference into the item's description. The next
  run uses and updates an item only when both match, so an item someone else made with that name
  is still left alone. A run started straight after one that stopped asks Fabric how that create
  went, if Fabric had answered it, and waits up to 10 minutes for one still in progress; if Fabric
  is still working on it after that, the run stops and says to run it again in a few minutes. If
  it isn't known how the create went, or Fabric says it made the item but it isn't in the
  workspace, the run waits, then asks before creating the item again (with `--yes` it stops
  instead and keeps the pending record). However long ago the first request was, it is created
  again only if Fabric says that create failed or someone answers yes, since time alone doesn't
  show Fabric won't still make it. A create that times
  out keeps its pending record for the next run, rather than making another. Creates, new client
  secrets and the writes that store a new secret are sent once: if the answer is lost or the
  service errors, the run stops rather than sending the request again, and the next run finds
  what was made by its reference.
  Every client secret the installer adds — for the notebooks, the Key Vault, the model's
  connection and the Azure SQL reader — gets its own reference in its name, saved before Entra is
  asked, so the next run can find the exact secret even if the run stopped before saving its key
  ID. The install record keeps looking for that secret until it's found, and from 10 minutes on
  each run says it hasn't appeared yet. A secret whose value may already be stored (in the Key
  Vault, the Fabric connection or the Power BI credential) stays on the app and in the install
  record until a newer one is in use.
  Then the connection's and the SQL reader's are removed; Key Vault secrets stay until they
  expire, as before, since a pipeline run already going may still use one, and the run names any
  it couldn't confirm so they can be deleted by hand. One that was turned down is removed straight
  away. If two secrets carry the same reference, neither is touched and the run says so. An old
  secret stays in the install record until Entra confirms it's removed, or the app no longer lists
  it, so a later run finishes the job.
  Installs interrupted by an earlier version aren't tidied up automatically: look for an item
  beside a `_2` copy, and for an installer-named secret on the app registration that isn't the one
  in the install record.
- **Model updates that change the schema can go ahead, once you agree.** Fabric now turns down a
  semantic model update that has to clear data, with `RequiredOptionsMissing`, and changes
  nothing. `update` failed that way after a new version added model columns, as did `install` or
  `repair` run again from such a version. The installer still tries to keep the data. When it
  can't, it names the model, warns that reports on it show no data until it's reloaded, and asks
  before clearing it. `--yes` alone stops instead; `--allow-model-reset` is the unattended
  equivalent. A changed model is then reloaded: the install record keeps that it's owed a reload
  until a whole-model refresh the installer requested after the change was applied finishes
  cleanly by its own details, so a run that stops or fails part way reloads it next time.
  Refreshes it didn't request, such as the pipeline's, which may cover only some tables, and ones
  that reported problems never count. If the installer can't tell whether a change was applied, the next run applies it again
  before reloading. `update` and `install` end as failed when that reload fails or can't run,
  and say "still reloading" rather than "Up to date" when they don't wait for it. A waited
  `refresh` that other refreshes keep from starting its own reload fails rather than reporting
  success. On Azure the
  model is reloaded before the first load starts, and a job run Azure gives no name for is no
  longer counted as finished.
- Not changed: the installer never installs anything with winget, so there's no `--scope user`
  fallback to add. Execution policy and Constrained Language Mode were already covered.

**App filters reach every page.**

- **More of each page follows the filter bar.** Consumption now takes the date range, organization
  and agent filters: Cowork and Copilot Studio per-person credits narrow to the people in the
  chosen organizations, Studio agents to the chosen agents, and the All products overview to the
  chosen dates. Feedback takes agent type and agent; Governance takes agent; Agent Evaluation takes
  the date range and organization, and its own slicers narrow further.
- **"Not filtered by …" hints.** Where a filter can't reach a card (the model has no matching
  column, or the card is deliberately fixed, such as the budget runway or Copilot Studio's tenant
  billing), the card now says so in one short line instead of silently ignoring it. Cost vs value
  leaves out Copilot Studio and Cowork cost when an organization filter can't narrow them.
- **Filter state stays shared across pages**, and each query states how it takes each filter, so
  a test now checks that every query factory applies the active filters or gives a reason.
- No model changes: every new filter is a `CALCULATETABLE` argument on columns the shipped
  templates already hold, so the Fabric and Azure hosts both support it.

**App: more varied visuals.** The app leaned almost entirely on bar charts. Five cards now use
the chart that best fits their question, with the same palette, Vega-Lite and the existing
performance budget. No new dependencies, and no query or install changes.

- **Bottom line:** each KPI tile shows a small sparkline of its full months under the arrow,
  with a text description for screen readers.
- **Budget runway:** the progress bar is a bullet: spend to date, a tick for even pace to date, a
  tick for the budget and a lighter band for where this pace ends the month.
- **Where it is landing:** a new scatter places each department (or other organization field) by
  seats in use and expert hours per seat, sized by licensed seats, with median lines. It shows
  when there are at least three groups.
- **Feedback:** satisfaction by surface or agent is a diverging bar, thumbs down to the left of
  zero and thumbs up to the right, instead of a single satisfaction bar.
- **Copilot Studio:** the daily credits and cost chart adds a 7-day average line over the bars, so
  the trend reads through spiky days. Days with no usage count as zero.

**Models: less refresh-time calculation and smaller ID columns.** See
[Model slimming](docs/MODEL-SLIMMING.md). Deployed size and latency improvements require
same-data measurements; these changes alone do not establish a performance result.

- **No calculated columns on the ValueLens audit fact.** The processor (Fabric notebook section
  10c, the DuckDB core and the Azure process job) now writes the 24 columns the report reads, for
  example `Is Prompt Row`, `Is Usage Row`, `Task Breakdown Group`, `Work Shape` and
  `Session Turn Band`. The model imports them instead of computing them in memory at every
  refresh, and drops 7 helper columns, removing the fact's calculated-column obstacle to Direct
  Lake. A test
  checks the output against a reference written from the original DAX; live equality is a
  separate validation gate.
- **Integer message and thread bindings.** `ThreadId` and `Message_Id` keep their names but now import the
  processor's 60-bit integer `Thread_Key` and `Message_Key` instead of the id text, so session and
  prompt counts must pass old/new equality checks. `CreationDate` is no longer imported; the Calendar and agent
  last-activity measures read `InteractionDate`, the same day. Incremental refresh still filters
  on `CreationDate` at the source.
- **Migration before model readiness.** Fabric processor version 2 and the changed Azure
  fingerprint force a one-time full rebuild. On Azure, migration `V007` adds the columns.
  Typed-null model fallbacks are transitional compatibility, not successful data validation:
  publish the populated columns and refresh every model partition before switching the app.
- **Cross-month conversations stay correct on incremental runs.** Added, changed and deleted
  thread/message rows update dependent historical values while retaining unrelated snapshots.
  Fabric records older changed days durably, and its refresh notebook reloads historical audit
  partitions before acknowledging the change. Failed refreshes remain pending for retry.
- **Agent Evaluator:** drops five unused calculated columns, including
  `Knowledge Citations[Topic (conversation)]`, which scanned every activity event for each
  citation.
- Applied by the new `scripts/Update-Model-Slimming.py` (`--check` reports stale templates) and
  `scripts/Update-Model-Refresh-Fixes.py`. Desktop refresh checks are listed in the doc.

**Bounded dashboard detail with full-population summaries.** Person and agent lists return at
most 1,000 rows with explicit tie breakers and truncation notices. Totals and agent spotlights
are calculated over the full filtered population, not the visible sample. Value/cohort and
Studio concentration summaries are calculated server-side rather than downloading every
person. Missing or inconsistent required totals show an error instead of a sample-based
fallback. Query pacing and retry protections are unchanged. App build validation and live
old/new DAX equality remain delivery gates; no latency improvement is claimed here.

## 2026-10-14 — Analytics Hub installer 0.6.5

**The current release.** 0.6.5 replaces 0.6.2 as Latest, so the `releases/latest` links, including
the PowerShell command, now serve it:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
```

To pin this version, use
`irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.5/install.ps1 | iex`.

**Coming from 0.6.2:** 0.6.5 includes everything in the 0.6.3 and 0.6.4 pre-releases below: the
PowerShell route as the default in the docs, `install.ps1 -UseInstalledNode` for an IT-approved
Node.js, a download with fewer unsigned native files, the Windows command quoting fix and the
Fabric uninstall connection cleanup. Read those sections before you update.

**Update an existing install:** run the PowerShell command again, or open installer 0.6.5 and
choose **Repair or change**. What the installer deploys is the same as 0.6.2. The tag also
publishes the `valuelens-jobs` and `valuelens-web` images as `0.6.5`.

**Fixed in this release:**

- **Installer:** an install in a OneDrive-synced folder (such as Documents) no longer stops with
  `EPERM: operation not permitted, rename '…valuelens-install.json.tmp'`. Saving the install record
  now retries while the sync client holds the file, and if it stays locked it writes the record in
  place so the run's progress is kept.

**Also:**

- **Build checks.** The ARM drift check ignores the nested Bicep generator metadata, so a newer
  Bicep CLI on the build machine no longer fails it. The deployed template is unchanged.

## 2026-10-14 — Analytics Hub installer 0.6.4 (pre-release)

**A pre-release, superseded by 0.6.5.** 0.6.4 stays a GitHub pre-release and was never Latest.
Use 0.6.5, which includes all of it. To pin 0.6.4 anyway, use
`irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.4/install.ps1 | iex`.

**Update an existing install:** run the PowerShell command again, or open installer 0.6.4 and
choose **Repair or change**. What the installer deploys is the same as 0.6.2. The tag also
publishes the `valuelens-jobs` and `valuelens-web` images as `0.6.4`.

**Fixed in this release:**

- **Fix: Windows installer command with special characters in Node.js paths.** The generated
  `analytics-hub.cmd` quotes the Node.js path in its missing-runtime message, so parentheses or
  ampersands in an installed Node.js path or user profile do not break the command before it
  starts. Applies to both bundled and IT-approved Node.js.
- **Installed-Node recovery instructions** now give the command that keeps
  `ANALYTICS_HUB_USE_INSTALLED_NODE=1`, as the update instructions already do. Windows package
  checks also cover the installed-Node route in PowerShell 5.1 Constrained Language Mode.
- **Fabric uninstall deletes the model's SQL connection.** The connection lives outside the
  workspace, so it was left behind. A failure to delete it only warns. The closing note no longer
  mentions a Key Vault for installs that keep the secret in the notebook.

**Also:**

- **Known limitation:** the generated Windows management command still cannot preserve non-ASCII
  installed-Node or Documents paths. [Known issues](docs/KNOWN-ISSUES.md#installing) records this
  separately from the special-character quoting fix.
- **Docs.** The README is shorter and separates the automatic and manual install paths, with a
  [manual install](docs/MANUAL-INSTALL.md) page and an [FAQ](docs/FAQ.md).
- **Contributing.** Pull requests into `main` now need passing checks and a code owner's
  approval, and only Keith creates release tags. See [Contributing](CONTRIBUTING.md#reviews-and-releases).

## 2026-10-14 — Analytics Hub installer 0.6.3 (pre-release)

**A pre-release, for testing.** 0.6.3 is a GitHub pre-release, so the `releases/latest` links still
serve 0.6.2. To try it, download installer 0.6.3 from
[its release](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/tag/installer-v0.6.3),
or run its pinned PowerShell command:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.3/install.ps1 | iex
```

What the installer deploys is the same as 0.6.2. This release changes how you can run it, the
docs and what's in the download. The tag also publishes the `valuelens-jobs` and `valuelens-web`
images as `0.6.3`.

**Docs:**

- **Simpler prerequisites, and a page per step.** [Prerequisites](docs/PREREQUISITES.md) opens
  with one table of who does what, on Fabric and Azure, and how long it takes, then every
  permission and role as **API | Permission | Reason** and **Scope | Role | Reason** tables. The
  README follows Getting started: Prerequisites, [Install](docs/INSTALL.md) and
  [Verify](docs/VERIFY.md), with [Update](docs/UPDATE.md), [Uninstall](docs/UNINSTALL.md),
  [Troubleshooting](docs/TROUBLESHOOTING.md), [Known issues](docs/KNOWN-ISSUES.md) and
  [Architecture and costs](docs/ARCHITECTURE.md) pages. The installer README keeps its old headings,
  so existing links still land.
- **The wiki.** docs/ is published to the
  [wiki](https://github.com/microsoft/AnalyticsHub-Dashboard/wiki) on every change to main.
- **Install routes that don't rely on the exe** (part of #77). [Install](docs/INSTALL.md) leads
  with the PowerShell one-liner and keeps the exe as an option. It adds routes for an IT-approved
  Node.js, and for PCs that can't run anything locally: your IT team deploys it, or you run it
  from an approved admin workstation. The docs, `install.ps1`'s help and the release notes no
  longer suggest `-ExecutionPolicy Bypass`, `irm | iex` under `AllSigned`, or clicking past
  SmartScreen. Where policy blocks a route, they point to another route or your IT team. They also
  say what a matching SHA-256 proves: the file is the one in the release, not who published it.
  [Known issues](docs/KNOWN-ISSUES.md#unsigned-files-in-the-download) lists the unsigned native
  files still in the download, and when they load.

**Installer:**

- **`install.ps1 -UseInstalledNode`** runs the installer with the Node.js already on the PC (x64,
  22.13 or later on 22.x, or 24.x), such as one your IT team has approved, instead of the
  `node.exe` in the zip. For `irm | iex`, set `$env:ANALYTICS_HUB_USE_INSTALLED_NODE = '1'` first.
  It downloads and checks the same zip, and uses the same folders and install record, so you can
  switch routes without a second install. `analytics-hub.cmd` and the update command keep using
  that Node.js. See [IT-approved Node.js](docs/INSTALL.md#it-approved-nodejs).
- **Fix: the command `install.ps1` leaves behind** now prints the reinstall command with its `|`
  intact, instead of cmd.exe treating it as a pipe.

**Packaging:**

- **Fewer unsigned files in the download.** The zip leaves out esbuild's `esbuild.exe`, `tsx` and
  msal-node-runtime's native sign-in broker for Windows, Linux and macOS: 15 native files, about
  19 MB of the zip and 54 MB unpacked.
  Nothing loads them: Rayfin lists `tsx` but never imports it, compiles the schema with
  TypeScript's `tsc.js`, and doesn't use the broker. The build checks Rayfin still starts and
  compiles the schema without them.

## 2026-10-14 — Analytics Hub installer 0.6.2

**The current release.** 0.6.2 is the first release since 0.5.1 to be marked Latest, so the
`releases/latest` links, including the PowerShell command, now serve it:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
```

To pin this version, use
`irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.2/install.ps1 | iex`.

**Coming from 0.5.1:** 0.6.2 includes everything in the 0.6.0 and 0.6.1 pre-releases below: the
PowerShell command and Azure Cloud Shell, the no-Key-Vault default for new Fabric installs, region
preflight and private networking for Azure under policy, and the app's report packs, Ask,
org-scoped access and delegation. Read those two sections before you update.

**Update an existing install:** open installer 0.6.2 and choose **Repair or change**. On Azure it
pulls the `0.6.2` images and runs any migrations the install hasn't had yet (V006 from 0.6.1).

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.6.2`.

**Fixed in this release:**

- **Installer, Azure Cloud Shell:** the plan before **Go ahead?** said to keep the PC plugged in
  and awake; in Cloud Shell it now says to keep the Cloud Shell tab open. Without a storage
  account, each run now ends by saying how to download the install record (**Manage files** >
  **Download**, with the path to enter), and a record uploaded with **Manage files** > **Upload**
  is moved from the home folder to where the installer looks, so running it again carries on
  instead of setting up a second copy.

## 2026-10-13 — Analytics Hub installer 0.6.1 (pre-release)

**A pre-release, for testing.** 0.6.1 fixes problems found while testing 0.6.0. Like 0.6.0, it's a
GitHub pre-release, so the `releases/latest` links still serve 0.5.1. To try it, download
installer 0.6.1 from
[its release](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/tag/installer-v0.6.1),
or run its pinned PowerShell command:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.1/install.ps1 | iex
```

**Update an existing install:** open installer 0.6.1 and choose **Repair or change**. On Azure it
pulls the `0.6.1` images and runs migration V006, and the next data load fills the new columns.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.6.1`.

**Fixed in this release:**

- **Azure: the first data load no longer fails with "The 'Agent_Key' column does not exist".** The
  Azure jobs' audit processor had fallen behind the Fabric notebook, so the curated table lacked the
  agent link and agent type columns (`Agent_Key`, `Agent_Type`, `Agent_Publisher` and the rest) that
  the semantic model reads, and the model refresh failed. The processor now matches the notebook:
  it flattens the agent platform and target fields, links agents, classifies agent types and drops
  the same non-user records (the Copilot Studio test pane, maker evaluations, agent authoring,
  autonomous and workflow runs). Migration V006 adds the 18 new columns to the curated table.
- **Azure: the audit collect no longer fails on an upgraded install with "Referenced column
  "AgentPlatform" not found".** When it merged new audit records into a day file that an earlier
  release had written, the collector asked that file for the new agent columns, which it doesn't
  have. Older day files now merge as they are, and their missing columns come out empty.
- **Azure: set-up carries on when Azure turns down the Azure SQL free offer.** A subscription that
  has used its free databases can get only `InternalServerError` on the new database, and set-up
  stopped at Azure resources. The installer now creates the database once more without the free
  offer, at the usual serverless price (it still pauses after an hour without use), says so, and
  remembers it. An existing database is never moved off the free offer.
- **Installer: the app deploys as the person who signed in to the installer.** The app deploy
  tool keeps its own saved sign-in. If that sign-in was for another account or tenant, the deploy
  ran as that account and failed with "The provided workspace was not found". The installer now
  passes its own Fabric token to the deploy tool when the saved sign-in is for someone else, as it
  already did in Azure Cloud Shell.
- **PowerShell launcher: removing an older version works in Windows PowerShell 5.1.** `install.ps1`
  no longer prints a Node.js error when it removes an older version, or when it runs with
  `-Uninstall`, in Windows PowerShell 5.1. Windows PowerShell 5.1 dropped the double quotes from
  the Node.js code that removes the folder. The code failed, and the launcher fell back to
  `Remove-Item`, which can't remove paths longer than 260 characters.
- **Plan review: the no-Key-Vault notebook secret shows as New.** With no Key Vault, each install,
  repair or update writes a new client secret into the notebooks, but the review listed it as
  "Already there" and counted it that way in its summary. It now shows New.

## 2026-10-13 — Analytics Hub installer 0.6.0 (pre-release)

**A pre-release, for testing.** 0.6.0 is published as a GitHub pre-release, so the
`releases/latest` links still serve 0.5.1. To try it, download installer 0.6.0 from
[its release](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/tag/installer-v0.6.0),
or run its pinned PowerShell command:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.0/install.ps1 | iex
```

**Update an existing install:** open installer 0.6.0 and choose **Repair or change**. It deploys
the updated notebooks, pipeline, models and app, and keeps your saved answers. An existing install
that keeps the app's secret in Key Vault keeps it there. Org-scoped access stays off until you turn
it on.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.6.0`, which the Azure
install pulls.

**In this release:**

- **Run it where exes are blocked:** a PowerShell command (`install.ps1` and
  `AnalyticsHubInstaller.zip` are now release assets), and Azure Cloud Shell.
- **Fabric without Azure:** a new Fabric install keeps the app's secret in the notebooks by default,
  short-lived and rotated, instead of in Key Vault.
- **Azure under policy:** a region preflight, hardened private networking, and the SQL firewall
  rule skipped when policy turns SQL public access off, with the real deployment error.
- **App:** report packs with PDF and PowerPoint export, Ask, org-scoped access (row-level security)
  and scoped delegation from the Share panel (Azure).
- **Newcomer fixes** from the self-serve test of 0.4.2: prerequisites, questions, flow sign-in,
  sharing, the Done page, the install record, Cowork's first load and data gaps.
- Agent Evaluator and Consumption Central refresh fixes, and chart redraw fixes.

### Ask

#### Added: ask questions about the data, in the app

**What changed.** The app has an **Ask** page with suggested questions for each page.

- **Fabric.** On a paid capacity, the installer builds and publishes a Fabric data agent over the
  Analytics Hub models, with guardrail instructions and the measures each page uses. The Ask page
  opens it and offers questions to copy. If building it fails, the install carries on.
- **Azure.** The installer creates an Azure AI Services account with a `gpt-5-mini` deployment by
  default (keys off; the web app's managed identity gets **Cognitive Services OpenAI User**), after
  checking model availability and quota, or uses an existing deployment. The web app's `/api/ask`
  answers inline and shows the queries behind each answer. It can only run the catalogue's named
  queries, as the signed-in user, with date and organisation filters; groups under 5 people are
  left out and rows are capped. Turns, queries and users are rate-limited, and logs keep questions
  and query names only.
- **Without either**, the page suggests questions and says how to turn Ask on. Azure installs from
  before Ask keep it off on update.

### Building the installer

#### Fixed: the installer exe builds again

- The app's `@microsoft/rayfin-*` packages are pinned to one version (1.35.1) and move together in
  Dependabot. A grouped update had left them on different versions, so the exe wouldn't build. The
  `installer-exe` workflow now runs when the app's package files change.

### Install from Azure Cloud Shell

#### Added: Azure Cloud Shell for PCs that can't run the installer

**Why.** On some locked-down PCs, AppLocker or WDAC rules stop the exe and the PowerShell
command's unpacked `node.exe` alike, which leaves no way to run the installer on that PC.

**What changed.** The same `irm … install.ps1 | iex` command now also works in Azure Cloud Shell's
PowerShell. There, `install.ps1` fetches the release's source from GitHub at the commit written
into it, checks the commit, runs `npm ci` from the lockfile and, if Cloud Shell's Node.js is older
than 22.13, downloads the release's Node.js and checks its SHA-256. It keeps everything in
`~/.analytics-hub` and leaves `~/.analytics-hub/analytics-hub` for later commands. In Cloud Shell
the installer:

- asks its questions in the terminal (`--ui` isn't available) and signs in with a code by default;
- with `--use-az`, checks the Azure CLI can reach every API before changing anything, and says to
  run `az login --use-device-code` if it's still on Cloud Shell's own sign-in;
- deploys the app with the installer's Fabric token (`RAYFIN_TOKEN`), so Rayfin doesn't wait for a
  browser sign-in;
- warns when Cloud Shell has no storage account, since the install record would go with the
  session, and notes the 20-minute idle timeout. Re-running carries on from the record.

See [Locked-down tenant / Azure Cloud Shell](installer/README.md#locked-down-tenant--azure-cloud-shell).

**Still blocked by.** Conditional Access policies that block sign-in with a code.

### Install from PowerShell

#### Added: a PowerShell command for organisations that block downloaded exes

**Why.** Many organisations block downloaded `.exe` files, so people couldn't start the installer
without cloning the repo and installing Node.js.

**What changed.** Each release now also has `install.ps1` and `AnalyticsHubInstaller.zip`, the
same payload as the exe. In PowerShell, run:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
```

It downloads the zip, checks its SHA-256 against the one written into `install.ps1`, unpacks it
under `%LOCALAPPDATA%\AnalyticsHub` (the same place as the exe) and opens the same browser steps.
No admin rights. It works in Windows PowerShell 5.1 and PowerShell 7, including Constrained
Language Mode, and through a proxy (`$env:ANALYTICS_HUB_PROXY`). If `irm | iex` is blocked, download
both files and run `install.ps1 -ZipPath`. It leaves `analytics-hub.cmd` behind for later
commands, and messages in the installer name that command when you started it this way. The
release notes give a command pinned to that release. See
[From PowerShell](installer/README.md#from-powershell).

**Still blocked by.** AppLocker or WDAC rules that stop programs under the user profile block the
unpacked `node.exe`, as they block the exe. `install.ps1` isn't Authenticode-signed yet.

The exe is unchanged and stays the main download.

### Private networking under Azure Policy

#### Fixed: private networking deploys where Azure Policy denies public access

**Why.** A tester hit a deploy failure involving public and private endpoints. Several resources
didn't follow the networking choice, and policy errors were hard to read.

- **Locked down when private.** The Ask AI Services account turns public access off and gets a
  private endpoint. Storage's firewall denies by default. Log Analytics turns public ingestion and
  query off, and Container Apps logs reach it through a diagnostic setting (in the
  `ContainerAppConsoleLogs` and `ContainerAppSystemLogs` tables). Every subnet gets a network
  security group. Public mode is unchanged.
- **Private DNS zones.** A new advanced setting creates the `privatelink.*` zones (the default), uses
  existing zones in another resource group such as a Landing Zone hub, or leaves DNS to Azure Policy.
- **Policy errors.** The installer walks the nested ARM error and names each policy, assignment and
  resource it blocked. It no longer tells you to choose Private networking when you already have,
  keeps the original error, and prints the command for the full error.
- **Storage.** With private networking, the installer never calls the storage account from your
  machine, and says why.

#### Fixed: Azure SQL firewall rule fails when Azure Policy switches SQL public access off

**Why.** A tester's deploy failed on the SQL firewall rule with `DenyPublicEndpointEnabled`
("Unable to create or modify firewall rules when public network interface for the server is
disabled"). A policy switched the server's public access off as it was created, so the rule that lets
Azure services in couldn't be added. The installer showed only the generic `DeploymentFailed …
ResourceDeploymentFailure` text.

- **Detected before deploying.** On a first Azure install, the installer reads the policy
  assignments it already reads for the region preflight. When one denies SQL public access, or
  modifies it to `Disabled` (built-in or custom, directly or in an initiative), the installer says so
  and uses Private networking, which deploys no SQL firewall rule. Under advanced settings, Private is
  the default and Public endpoints warns that the deployment would fail.
- **The real error.** When a deployment fails, the installer reads the deployment operations,
  following failed modules, and shows each failing resource with its own error code and message.
- **Existing installs.** If an existing public install hits this, the installer says networking can't
  change in place: uninstall and install again with Private networking, or ask for an exemption.

### Load warnings, Global Reader, Agent Evaluator environments and Fabric uninstall

#### Changed: a new Fabric install keeps the app's secret in the notebooks, not Key Vault

**Why.** Fabric notebooks can't get Microsoft Graph tokens from a workspace identity, so they need
the app's client secret. Until now that meant an Azure subscription and a Key Vault, which a tester
couldn't create. The notebook option was a last resort with a long-lived secret.

- **Default.** For a new Fabric install, the installer asks **Where should the app's client secret
  go?** and defaults to no Key Vault: the secret is written into the notebooks, and nothing in Azure
  is needed. `--key-vault` picks Key Vault; `--no-key-vault` (or `--secret-in-notebook`) skips the
  question. Installs whose record already uses a vault keep it, as does `--flow-identity app`.
- **Trade-off, stated in the wizard and READMEs.** Anyone with a role in the workspace, Viewer
  included, can read the secret, and it's copied into anything that copies the notebooks. There's
  no vault audit log or network control. Key Vault avoids this, and stays an option, as does
  handing the secret to a vault admin.
- **Recommended when you can't use a vault.** With no Azure subscription, or when you can't create
  a vault or write to the one you picked, the installer recommends no Key Vault.
- **Short-lived and rotated.** The secret lasts 90 days by default (`--secret-days <n>`, 1–730, on
  `install` and `rotate-secret`). Every install, Repair and update adds a new secret, rewrites the
  notebooks, then removes the older secrets. Apps you brought yourself aren't rotated.
- **Never stored elsewhere.** The secret isn't written to the install record or logs, and the
  installer refuses to write it into a workspace that's connected to Git.
- **Planned follow-up.** Once `notebookutils.credentials.getConnectionRef` (variable library
  connection references) ships in the Fabric notebook runtime, switch the default to a Fabric
  Connection that holds the secret, so workspace roles don't expose it. A Fabric Connection bound
  to each notebook by hand is a possible later option. Neither is built.

#### Added: an Azure region preflight

**Why.** A tester reported that Azure restrictions, mainly region restrictions, were the hardest
part of standing up the Azure target. The installer offered every region in the subscription.
Choosing one that Azure Policy or the subscription doesn't allow then failed partway through the
deployment.

- **Installer.** On a first Azure install, the region list shows only the regions where every
  resource can go. Regions are dropped if:
  - Azure Policy's allowed locations deny them. The installer reads the built-in policies, either
    assigned directly or in initiatives, and simple custom deny rules on `location`.
  - The subscription isn't offered a resource type it needs there.
  - Standard_LRS storage or Azure SQL is restricted there.

  The installer prints why each region was dropped. If no region passes, it stops before deploying,
  with a message that says what to ask an Azure administrator for. The Ask model's account only
  moves to regions that policy allows. If the installer can't read a policy, it still deploys, says
  so, and leaves that check to Azure.

#### Changed: a load that couldn't read everything is a Warning, not Succeeded

**Why.** A load that was refused by Resource Graph, wasn't licensed for Defender, or found no
transcripts still showed as *Succeeded*. Its page was then empty, with no reason given.

- **Load status.** `AnalyticsHub_Load_Status` reads `arg_status`, `defender_status` and the new
  `evaluator_status`. It records those loads in `load_log` as `Warning`, with a `reason_kind` of
  `empty`, `forbidden` or `unlicensed` and a plain reason. Warnings don't fail the run.
- **Installer.** Warning loads show amber, with their reason, in the browser and the terminal.
- **App.** The models gain a `Load Log` table (Analytics Hub model) and an `Evaluator Status` table
  (Agent Evaluator model). The freshness line shows a source's latest warning or failure. It sees a
  run at the next refresh, because the status step runs after the refresh. Azure has no run log,
  so the table stays empty there.

#### Changed: the installer gives Global Reader for agents when it can

**Why.** Resource Graph returns Copilot Studio agents only to an identity with an Entra role such
as Global Reader. The installer only told you to ask a Privileged Role Administrator, so agent
configuration often stayed empty.

- **When it assigns the role.** It applies when agents are read from Resource Graph and you're a
  Global Administrator or Privileged Role Administrator. The installer then assigns **Global
  Reader** to the app (Fabric) or the jobs' managed identity (Azure), and *Ready to set up* lists
  it.
- **Repeat runs.** It checks first, so it never assigns the role twice. If your sign-in can't make
  the assignment, it asks for `RoleManagement.ReadWrite.Directory` for that one call.
- **When you can't.** It shows a message to copy to someone who can. The message names the role,
  the principal and its object ID, and links to Entra's **Roles and administrators**.
- **App.** Without the role, the Governance page's agent configuration says *Not collected:
  permission missing*, not zeros.

#### Changed: Agent Evaluator asks which environments, and reads further back the first time

**Why.** The installer ticked only the default environment and moved on. The first run read only
14 days. Then the Agent Evaluation page said nothing about where it had looked.

- **Choosing environments.** With more than one environment, the installer always asks: *Read the
  environments that hold your Copilot Studio agents*. It checks each one for agents, four at a
  time with a short timeout, and ticks those that have some. If it can't tell, it ticks the default
  environment and says so.
- **How far back.** An environment's first read goes back 180 days (`FIRST_READ_DAYS`). A backfill
  reads at least 180 days too. Copilot Studio keeps transcripts for 30 days by default.
- **Status.** The parser writes `evaluator_status`, one row per environment, with the transcripts it
  read, over how many days, and why there were none.
- **App.** When there are no conversations, the Agent Evaluation page says how many transcripts it
  found, in which environments, over how many days, and how to add environments.

#### Fixed: uninstall on Fabric

**Why.** Uninstall did nothing on Fabric. Fabric also won't delete a workspace that still has
managed private endpoints, so deleting it by hand failed.

- `uninstall` on Fabric asks first, then deletes the workspace's managed private endpoints. It
  waits for them to go, then deletes the workspace. A 404 counts as already gone. It lists what it
  leaves alone.

### Data completeness

**Existing installs need the updated notebooks.** Run the installer and choose **Repair or change**
to deploy them. Until then, Copilot Studio totals stay blank when the credits flow lands only
per-user files, and Agent 365 can still show "year 1" dates.

#### Fixed: Copilot Studio totals were blank with only per-user credits

**Why.** When the credits flow landed only the per-user file, `studio_tenant_daily` stayed empty.
The app said "No daily credits" and the budget runway had nothing to project, even though the
per-user table held the credits.

- **Fallback rows.** `Ingest_Studio` and the Azure `studio` job sum `studio_user_daily` into
  `studio_tenant_daily` for the days and environments no export or per-agent file covers, with
  `source_file = 'ppac-api-users'`. Billed credits split by the prepaid share; non-billed credits
  count as prepaid. They're rebuilt each run, so a later export replaces them.
- **App.** Studio's empty states no longer say there's no usage when per-user credits exist. The
  breakdown by feature and model says it needs a Power Platform admin centre export, with a link
  and the steps.

#### Added: department coverage

**Why.** People with no Entra department drop out of every view by organisation, and nothing said
how many that was.

- The org ingester prints, and the Azure `org` job logs, "X of Y people have a department". Below
  80% it says to fill in Department in Microsoft Entra ID or add Workday org data.
- The installer's data check reports the same count after the first load.
- The app's by-organisation empty states and **What needs attention** show the coverage and the
  same advice.

#### Added: Microsoft 365 report status

**Why.** A Work patterns chart could be blank with no hint that the Graph report itself returned
no app usage.

- `Copilot_M365_Activity_Ingester` writes `m365_report_status`, one row per report per day read
  (`ok`, `no_activity`, `empty` or `unavailable`), and prints a warning for reports with no use.
  The Azure job writes the same rows to `raw/m365_report_status/` and logs them.
- The Apps and Platforms charts say "The report returned no app usage for this period" instead of
  showing a blank chart.

#### Fixed: smaller gaps

- **Shadow AI.** The installed AI apps, Cloud Discovery and device panels name the licence they
  need (for example Microsoft Defender Vulnerability Management) when Defender reports it
  unlicensed, and say "No data returned" when the probe ran but found nothing.
- **Agent 365 dates.** A `Date created` or `Last Activity Date` before 2000-01-01, which the
  registry sends for a missing date, is now blank in both Agent 365 notebooks. The rule is shared
  as `valuelens_core.dates.plausible_date`.

### Cowork first load and rerun

From the newcomer self-serve test of installer 0.4.2 (F3, F4, F5).

#### Changed: the first load doesn't fail on a Cowork Dataflow nobody has signed in to

**Why.** The installer creates the Cowork Dataflow but can't sign in to its connections. The first
load then failed on `Refresh_Cowork_Credits` with "Job instance failed without detail error",
turned the run red and gave no clear next step.

- Before the first load, the installer reads the Dataflow's saved connections. If there are none,
  that run sets the new pipeline parameter `SkipCowork=true`, which skips the Dataflow, so the
  other loads aren't red. Scheduled runs keep the default `false` and still fail loudly until
  someone signs in.
- The **Done** page and the terminal show an amber **To do: sign in to the Cowork Dataflow** card.
  It links to the Dataflow and lists the steps: **Configure connection** for the Viva Insights
  source and for the Lakehouse destination, then **Save** and wait for publishing. It also explains
  the `DataflowsStagingLakehouse` and `DataflowsStagingWarehouse` items Fabric adds.
- New **Load Cowork now** action (`load-cowork`). It waits until the Dataflow has finished
  publishing, refreshes it (trying once more after a minute if the refresh fails straight after
  the save), then runs the Viva load and the consumption model refresh and reports the rows loaded.
- "Job instance failed without detail error" on the Cowork Dataflow now reads *Needs sign-in: the
  Cowork Dataflow's connections aren't signed in (or it hadn't finished publishing)*, in the
  installer and in `dbo.load_log`.

#### Fixed: reruns no longer leave the Viva load falsely green

**Why.** `Run_Consumption_Viva` succeeded on empty input after a failed Dataflow. Rerunning the
Dataflow didn't rerun it or the consumption model refresh, so Cowork credits stayed empty while the
run looked fine.

- A rerun now also reruns steps that read what a rerun step wrote: the Viva load after the
  Dataflow, then the consumption model refresh.
- A Viva load that got no rows from the Dataflow shows as **to do**, not loaded. The Viva notebook
  writes its row counts to `Files/valuelens_installer/viva_load.json` for the installer to check.

### Sharing and the Done page

From the newcomer self-serve test of installer 0.4.2.

#### Fixed: the app's Share panel didn't name the viewer group

**Why.** The app reads who can view it from `fabric.config.json`. Only the prebuilt app got that
file: a deploy from source left it out, so **Share** fell back to "share the app item in Fabric".
A deployed app also wasn't redeployed when its access changed.

- A deploy from source now builds `fabric.config.json` into the app too, then removes it from the
  checkout.
- Repair offers to rebuild the app when who can view it has changed, such as the viewer group or
  the app being shared.

#### Changed: the installer asks you to share the app before the first load

**Why.** Viewers got "no access" because the app item was never shared with the group, and the
reminder only came at the end, after the first load, which can take hours.

- Straight after the app is deployed, the installer gives a link to the app item and the three
  clicks (**Share**, enter **Analytics Hub Viewers**, **Grant**). Choose **I've shared it** and
  it's recorded and not asked again. Choose **Later** and Repair asks again.
- **Share** in the Fabric app says "To give someone access, add them to" the group, with a link to
  it in My Groups, and who to ask. It says anyone in the group can open the app only once the app
  item is recorded as shared. Until then, it says the item still has to be shared, with a link.

#### Changed: the Done page starts with what's left, with messages for other admins

**Why.** Steps for other people were spread through the summary, so they were easy to miss, and a
Cowork Dataflow waiting for its sign-in showed as a red failed load.

- The Done page and the end of the terminal output start with "N steps left": a card per step
  with who does it, why, a link and the steps. Share the app, sign in to the flows, and sign in
  to the Cowork Dataflow come first, then the hand-offs.
- Each hand-off has a message to copy and send: Global Reader for **Analytics Hub Data
  Collector** for a Privileged Role Administrator (with its IDs and a Cloud Shell command), the
  product feedback export for a Microsoft 365 admin, the flow sign-ins for a Power Platform admin,
  and, optionally, the Cowork credits query for a Viva Insights analyst.
- A Cowork Dataflow refresh that fails before its sign-in shows as waiting, not failed, and isn't
  a reason to rerun.

### Power Automate flow connections

**Update an existing install:** choose **Repair or change**, or run `update`. Flows that are off
are signed in and turned on with you; flows that are on are left alone.

#### Added: the installer signs the flows in and turns them on

**Why.** Every flow was created turned off, with its connections left for you to make in Power
Automate. That meant finding the right connector, typing two URLs into each connection and
working out which actions use which. Until you did, the Copilot Studio credits flow never ran, so
the first pipeline load had no Studio data.

- **Connections made for you.** The installer makes the HTTP with Microsoft Entra ID connections
  the flows need, with their URLs filled in, named `Analytics Hub - Power Platform API` and
  `Analytics Hub - OneLake` (or `Analytics Hub - Azure Storage (<account>)` on Azure). It reuses
  ones of the same name that are signed in to already.
- **One sign-in link each.** It says who signs in to each, warns that a blocked pop-up opens
  nothing, and that whoever signs in, and the flows' owner, need Power Automate Premium. Then it
  waits while you sign in, or you choose **Do this later**.
- **Turned on before the first load.** Once the connections are signed in to, it points each flow
  at them and turns it on, so the Studio flow can be run before the pipeline starts. If you leave
  it for later, it says so: Copilot Studio data arrives after the flow runs and the next daily
  load. Run `update` to finish it.
- **Tidy.** It deletes connections it made before that nobody signed in to and no flow uses. Your
  other connections that aren't signed in to are listed, never deleted.
- **Steps when the flow is made.** Whatever it can't do (such as the feedback flow's Outlook
  connection) is shown as numbered steps as soon as the flows are created, not only at the end.
- **Product feedback export link.** The feedback flow's steps link straight to Microsoft 365
  admin center > Health > Product feedback, where the export is scheduled.

#### Fixed: Power Automate flows are easier to finish by hand

- The Copilot Studio credits flow saves in the designer: its Reset token steps set
  `@string('')` rather than an empty value, which the flow checker refused.
- Each action that needs a sign-in ends in **via Power Platform API**, **via OneLake** or
  **via Azure Storage**, so you can tell which connection to pick. Both connections use the same
  connector and looked alike.
- The steps say to allow pop-ups for make.powerautomate.com, and to sign in once per connection,
  then pick it on that connection's other actions.

### Prerequisites and questions

Findings F8, F12, F13 and F14 from the newcomer self-serve test of installer 0.4.2.

#### Changed: the prerequisite check covers more, in plainer words

**Why.** A newcomer couldn't tell from the list whether they had what the flows and the Cowork
credits need, and "PIM-eligible" meant nothing to them.

- New optional rows: **Microsoft 365 Copilot licences in the tenant**, **Power Automate Premium**
  (for whoever signs in to the flows) and the **Viva Insights analyst** role, which can't be
  checked, so it says how to get it.
- The Fabric administrator row says it's only needed if the tenant settings are off. A role you
  can activate says so, with a link to Privileged Identity Management.
- The check now records whether you can assign directory roles (Global Administrator or
  Privileged Role Administrator), as `canAssignDirectoryRoles`.

#### Changed: the questions explain themselves

**Why.** Defaults were picked by name, not by what the tenant uses, and some choices didn't say
what they cost or need.

- The Power Platform environment defaults to the tenant's default environment, with a note on
  DLP, Power Automate Premium and who can see the flows.
- The capacity question recommends F64 or larger for more than 10,000 people, and shows each
  capacity's SKU and region.
- A new install names the workspace `Analytics Hub` and the Lakehouse `Analytics_Hub`. Existing
  installs keep `ValueLens`.
- The Azure target is described in plain words.
- Cowork credits ask first whether you have the Viva Insights query IDs. **Not yet** uses the CSV
  export until you add them. The partition ID is prefilled with the tenant ID.
- The Copilot Studio, Cowork and Azure AI cards sit under **Credit consumption**, and their hints
  say what each needs.
- **Ready to set up** lists the costs that apply, with links to the pricing pages.

#### Fixed: an access contact from another tenant

**Why.** A record carried over from another tenant kept an outside address as the person to ask
for access.

- If the saved contact isn't on one of the tenant's verified domains, it's reset to you, with a
  note.
- The request-access link question says what it's for.

### Install record and launch

**Why.** In a newcomer self-serve test of installer 0.4.2, an install record for a deleted
workspace kept showing **Manage Analytics Hub**. Nothing said where the record was or how to start
again. A closed page couldn't be reopened without the printed link, the PC could sleep mid-setup,
and some text named internal tools.

- **A record whose workspace has gone.** After sign-in, the installer checks that the record's
  workspace still exists. If Fabric says it doesn't, or the record is for another tenant, the home
  page says so and offers **Start fresh** or **Keep this record**. Start fresh renames the record to
  `valuelens-install.<yyyyMMdd-HHmmss>.json` beside it. A network error or a 403 changes nothing.
  In the terminal, `install` asks whether to start fresh; other commands stop and say how.
- **Where the record is.** **Manage Analytics Hub** shows the record's full path, and notes that
  OneDrive may sync it.
- **Reopen the page.** The installer's window says to press **Enter** to open the page again. A
  page opened without the link says to do that.
- **Keep awake.** The exe stops Windows going to sleep while it runs. The plan says to keep the
  PC plugged in and awake until setup finishes.
- **Wording.** The web page says you can close the window while a run carries on, not Ctrl+C. The
  app deploy says a browser window may open for sign-in, without naming its deploy tool.

### Before you start checklist (docs)

Docs only. Nothing in the installer, app or notebooks changes.

#### Changed: one checklist for everything you need before you install

**Why.** A newcomer had to piece together what to ask for from three overlapping lists, found out
about the Viva Insights query, Power Automate Premium and the data policy only part-way through,
and had no idea how long it would take or what it would cost.

- **[Before you start](docs/PREREQUISITES.md)** is now the one checklist, organised by person: you,
  the Fabric admin, the Power Platform admin, the Viva Insights analyst, the Entra admin and the
  Microsoft 365 admin, then each optional extra with what it needs. The root, Fabric and installer
  READMEs link to it rather than repeat it.
- **Send this to your Viva Insights analyst first.** A short note to forward, so the Cowork credits
  query exists before you start. The partition ID defaults to the tenant ID, and you can add the
  query later.
- **How long it takes**: about 5 minutes of questions, 15 minutes of setup, and the first data
  about 25 minutes after **Go ahead** (about 2 hours for 180 days). Keep the PC awake and plugged
  in.
- **What it costs**: links to the official pricing pages for Fabric capacity (with a size hint),
  the Fabric free trial, Power Automate Premium and the optional Azure resources. No prices are
  written down.
- **Fabric README.** The installer comes before the manual setup video. Sharing is two steps:
  share the app with Analytics Hub Viewers once, then add people to the group. The data source
  cards are named as the installer shows them, and the Dataflow staging items are explained.
- **Credit consumption** docs use the card names (Copilot Studio credits, Copilot Cowork credits,
  Azure AI costs). A broken link from the Fabric README to the installer's download check is
  fixed.

### Org-scoped access (row-level security)

**Nothing changes unless you turn it on.** Upgrading or choosing **Repair or change** deploys the
models exactly as before. To use it, run the installer's `access` command and choose **Turn on
org-scoped access**. See [Org-scoped access](docs/PERMISSIONS.md#org-scoped-access-row-level-security).

#### Added: each viewer can see only the orgs they're given

**Why.** Everyone in Analytics Hub Viewers saw every org. A leader sharing the dashboard with their
own org had no way to keep the rest of the tenant out of it.

- **Scopes.** A viewer can see everyone, everyone below a person (from the org data's manager
  chain), or one department or country. The installer's `access` command adds and removes them,
  switches between department and country, applies the changes and turns the feature off again.
- **Models.** When it's on, the ValueLens, Consumption Central and Agent Evaluator models get two
  roles and two hidden access tables. Tenant-wide data (spend, agent inventory, Defender, Resource
  Graph, product feedback) shows only to people who see everyone.
- **Turning it on keeps everyone's view.** Current members of the viewer group, and you, get an
  "everyone" scope. People added to the group later see nothing until they're given a scope.
- **Role members are applied after every deploy.** A model deploy drops them, so the installer
  runs the new `AnalyticsHub_Access_Scope` notebook through the XMLA endpoint after each deploy,
  then checks the result by querying as a seeded viewer. It needs **Allow XMLA endpoints** and a
  capacity with the XMLA endpoint set to Read Write. On Azure the Power BI workspace has to be on a
  capacity, and installs with private networking aren't supported yet.
- **App.** Pages say whose data they show ("Showing: people below …"). A viewer with no scope sees
  who to ask instead of empty pages.
- **Data.** The org data gains an `OrgPath` column (the manager chain by UPN) on both targets. Azure
  gets an `access_scope` table (migration V005) and an `access_people` view, and the jobs' publish
  step loads the scope list into it.

#### Added: leaders give their own org from the Share panel (Azure)

**Why.** Every scope change went through an admin running the installer, even when a leader only
wanted to share their own org with someone who works for them.

- **Admins** (AnalyticsHub.Admin) give anyone the people below a person, or an org, from **Share**
  in the app, and can let them share their org in turn.
- **Leaders** with a "can share" scope give someone their own org: the people below them. They
  can't pass on "can share" and take back only what they gave. Nobody gives "everyone" from the
  app: that stays in the installer.
- **Waiting for an admin.** The delegate is added to the viewer group as the signed-in person. When
  Microsoft Entra doesn't allow that (only group owners and directory admins can), the scope waits
  until an admin approves it in the Share panel. No new Graph permissions.
- **Applies in minutes.** The web app saves the scope to Azure SQL as its managed identity and
  refreshes the models' access table. Changes close together share a refresh; if Power BI won't
  take one, the change applies at the next scheduled refresh. The jobs' load leaves these scopes
  alone.
- **Fabric** stays admin-only, through the installer. The Share panel says who to ask.

### Fabric App: chart redraw and Shadow AI fixes

#### Fixed: charts that collapsed after a filter, and missing Shadow AI bars

- **Row charts redraw when their row count changes.** Charts with one row per category (by org,
  city, country or surface) set their height from the row count. When a filter or a different
  grouping returned fewer rows, the plot kept its old layout: the rows collapsed onto one line and
  the bars vanished until the window was resized. Every chart now redraws from scratch when its
  row count changes.
- **Cloud Discovery shows its unreviewed apps.** Defender for Cloud Apps leaves most apps
  untagged (an empty posture) or marks them Monitored. The Shadow AI tools query only caught a
  blank posture, so these apps had no colour and drew no bar. Anything that isn't Sanctioned or
  Unsanctioned now reads as Not reviewed, as the Cloud Discovery KPI already counts it.

Redeploy the app (**Repair or change**) to pick these up. The models don't change.

### Agent Evaluator and Consumption Central model fixes

#### Fixed: refresh failures and an empty Credit Consumption page

**Why.** On a large tenant the Consumption Central and Agent Evaluator models failed to refresh,
and in Fabric mode the Agent Evaluator's Credit Consumption page was always empty.

- **Consumption Central: connection pool exhausted.** The credit and Azure tables that are read
  column by column (`studio_tenant_daily`, `studio_agent`, `studio_user` and the four
  `azure_*` spend and health tables) now buffer the Lakehouse table first. Unbuffered, the SQL
  endpoint was queried once per column.
- **Agent Evaluator: `'Agent Turns'[Response Seconds]` ran out of memory.** It now scans just the
  conversation, role and timestamp columns with `FILTER(ALL(...))` instead of
  `CALCULATE(..., ALLEXCEPT(...))`. The values are the same.
- **Agent Evaluator: Credit Consumption page empty in Fabric mode.** Nothing in Fabric writes the
  `credit_consumption_*` tables the page read. A new `FabricCreditTable` function reads them when
  they have rows, else the Consumption Central add-on's `studio_agent`, `studio_user` and
  `studio_tenant_daily` tables (latest snapshot), renamed to the export's columns.
- **Agent Evaluator: Agent Name Map.** In Fabric mode it now reads the credit-side agent names
  too, instead of an empty table. Both of its key columns are relationship keys, so a new
  `AgentNameMapRows` function keeps them unique the way the engine compares text (ignoring case
  and trailing spaces): one row per credit name, and a blank or already claimed `agent_schema`
  becomes `(unmatched) <name>`. Unmatched names used to share a blank key and fail the refresh.

The changes are applied by `scripts/Update-Model-Refresh-Fixes.py` (`--check` reports templates
that need it). **Repair or change** deploys the updated models; refresh them afterwards.

### Fabric App: report packs, PDF and PowerPoint

#### New: report packs, exported as PDF and PowerPoint

**What changed.** The Fabric App, which serves both the Fabric and Azure paths, can now build and
export reports (#24).

- **Report packs.** A pack is a named, ordered list of sections taken from any page, listed under
  **Reports** in the sidebar. *Exec pre-read*, *Finance weekly* and *Adoption review* come built
  in; **Save a copy** starts a new pack from one. **New pack** opens an editor to name a pack, tick
  sections and order them. Packs are stored with the other settings: in the app's SQL database on
  Fabric, where anyone who can open the app can change them, and in Table Storage through
  `/api/settings/ReportPack` on Azure, where saving needs `AnalyticsHub.Admin`. A pack skips, and
  names, sections whose page this install hides.
- **Download PDF.** Every page and pack can be printed as a report laid out for paper, through the
  browser's **Save as PDF**. Where the host blocks the print dialog, it downloads as an HTML page
  to print instead.
- **Download PowerPoint.** A deck with a cover (filters, data dates, sections left out) and one
  slide per chart or table, built in the browser with `pptxgenjs`.
- **Data dates in file names.** Exports and each chart's **Download CSV** are named with the
  date the data runs to, such as `exec-pre-read-data-to-2026-10-11.pptx`.

Scheduled digests by email are not part of this change. The Power BI templates are unchanged.

---

## 2026-10-12 — Analytics Hub installer 0.5.1

**Updating is optional.** 0.5.1 changes how the exe is released and some wording. What the installer
deploys is the same. To update, download installer 0.5.1
[from this repo](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe),
open it and choose **Repair or change**.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.5.1`, which the Azure
install pulls.

### Changed: the download explains its warnings and how to check it

**Why.** The exe isn't code-signed yet, so Edge says it "isn't commonly downloaded" and Windows
SmartScreen may block it. That's a reputation warning, not a malware detection. An unsigned file
builds reputation by its hash, so each new version starts again from nothing.

- **Release notes** now list the exe's SHA-256, show the PowerShell command that checks it, and
  say what to click past the warnings. For a signed exe they say how to see the signature instead.
- **READMEs.** A new [Check the download](installer/README.md#check-the-download)
  section, linked from every download link, has the same steps and points to
  [running it with Node.js](installer/README.md#without-the-exe) for organisations that
  block the download.

### Added: the release is ready for ESRP signing

- `packaging/sign-installer.azure-pipelines.yml` is an Azure DevOps pipeline. It signs a drafted
  release's exe with ESRP using the Microsoft Corporation certificate, checks the signature, then
  replaces the draft's exe, `.sha256` and notes. Signed exes take the publisher's SmartScreen
  reputation, so new versions don't trigger the warning. It needs ESRP onboarding before it can run.
- `packaging/finish-exe.js` checks that a signature is valid, from Microsoft Corporation and
  timestamped. It writes or checks the `.sha256` and writes the release notes. The `installer-exe`
  workflow and the signing pipeline both use it.
- **Publishing check.** When an installer release is published, `installer-exe` downloads the exe and
  checks it against its `.sha256`. With the repo variable `REQUIRE_SIGNED_INSTALLER` set to `true`, it
  also requires the signature. A release that fails goes back to being a draft, so the download link
  keeps serving the last good version.

### Changed: Azure is no longer in preview

- The READMEs, prerequisites, issue templates and the installer no longer call the Azure target a
  preview. The installer README section is now [Azure target](installer/README.md#azure-target), so
  links to `#azure-target-preview` open the top of that README instead.

---

## 2026-10-12 — Analytics Hub installer 0.5.0

**Update an existing install:** download installer 0.5.0
[from this repo](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe),
open it and choose **Repair or change**. Nothing about your install changes: the install record,
the Fabric items, the Azure resources and the `valuelens-jobs` and `valuelens-web` images keep
their names.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.5.0`, from this repo,
which the Azure install pulls.

### Changed: Analytics Hub has its own repo

- Analytics Hub moved from ValueLens to `microsoft/AnalyticsHub-Dashboard`. Downloads, issues and
  releases are here from 0.5.0. The old ValueLens download link serves 0.5.0 too, through a
  one-off release there, so installs that bookmarked it still get the update.
- The repo has a flat layout: `installer/`, `app/`, `fabric/`, `azure/`, `core/` and `samples/`.

### Added: update notices

- The installer checks this repo's latest release when it starts and says when a newer one is
  out. It stays quiet when it can't reach GitHub, for example offline or behind a proxy.
- The Azure web app's update banner reads this repo's releases and recognises `installer-v` tags.
  Azure installs up to 0.4.2 learn about 0.5.0 from the one-off ValueLens release.

### Changed

- The Teams app's website link points at this repo.
- The `valuelens-jobs` and `valuelens-web` images carry this repo as their source.

---

## 2026-10-12 — Analytics Hub installer 0.4.2

**Update an existing install:** download installer 0.4.2, open it and choose **Repair or change**.
Your saved answers are kept, so it asks fewer questions. If **Give the group Build on the models**
failed last time, run the installer's **access** command.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.4.2`, which the
Azure install pulls.

### Changed: fewer questions, with the rest under Advanced settings

**What changed.** The installer had gained a question for each new option: the reporting currency,
who can view, the schedule, Resource Graph's scope and more. A first install now asks only what it
can't guess.

- **The short path.** Fabric: sign in, the data sources, the capacity and workspace, the app
  registration and the Key Vault. Azure: sign in, what to collect, the subscription, resource group,
  region and Power BI workspace. A source that can't work without more, such as a flow's Power
  Platform environment, still asks for it.
- **Advanced settings.** One new question, **Change the advanced settings?**, comes after the data
  sources. **No**, the default and what `--yes` answers, keeps what you chose last time or takes the
  defaults. **Yes** asks as before: the Power BI items, who can view, audit history, tenant size,
  the Lakehouse name, a new vault's details, the schedule, the first load, the currency and
  Resource Graph's scope. On Azure it also covers demo mode, the SQL region, the name prefix, tags,
  networking and where credits come from. The plan still shows every setting before you approve it.
- **No currency question.** The Value page reports in US dollars unless you choose another under
  Advanced settings, with `install --currency GBP --exchange-rate 0.79`, or later under **Prices**
  in the app. A saved choice is kept.
- **Without Advanced settings,** a new install creates the **Analytics Hub Viewers** group with you
  as the contact, and a new Key Vault goes in `rg-valuelens` (it asks if you can't use that).

**Why.** Each option made sense alone, but together they made the first install long. Most
organisations take the defaults.

**What you need to do.** Nothing. Saved answers in `valuelens-install.json` still apply, and every
flag still works.

### Fixed: currency separators shown as "?" and Build not granted to a new viewers group

- The plan's currency line and the Value page's cost summary showed **USD ? US dollar** and
  **Loading?**. They now show **USD · US dollar** and **Loading…**.
- On a first install, the installer could create the **Analytics Hub Viewers** group and then fail
  to give it Build on the models (*"Parameter identifier is missing or invalid"*), because Power BI
  hadn't seen the new group yet. It now waits and retries for up to two minutes. To fix an install
  that hit this, run the installer's **access** command.

### Fixed: the browser page

- Only one scrollbar on the right: the page no longer scrolls behind the log.
- The steps on the left show only the chosen target's. A Fabric install no longer shows **Done**
  struck through, or Azure steps that never come.
- The Cowork credits Dataflow's sign-in steps show as numbered steps rather than broken lines, in
  the terminal too.

### Fixed: a network blip no longer fails the install, and an unrefreshed model says so

- A brief network or DNS failure on the PC running the installer (for example *"Failed to resolve
  'login.microsoftonline.com'"*) made the sign-in token call fail and stopped the install while it
  watched the first load, even though the load carried on in Fabric. Token calls now retry with
  backoff, and watching a pipeline run keeps going through up to 20 minutes of lost connection.
- When the semantic model hasn't been refreshed yet, the app's pages showed raw engine errors such
  as *"needs to be recalculated or refreshed"*. They now say **Data not loaded yet**, and explain
  to wait for the first load or choose **Repair or change** in the installer.

### Fixed: Defender agents reported as "Not licensed" when a column was missing

- Defender's **AgentsInfo** table is in preview and its columns vary between tenants. The agents
  probe failed when a column such as `AgentName` was missing, and reported it as **Not licensed**.
  It now reads every optional column only when it's there, and reports a missing column as a failed
  query rather than a missing licence.

---

## 2026-10-11 — Analytics Hub installer 0.4.1

**Update an existing install:** download installer 0.4.1, open it and choose **Repair or change**.
It asks for the Value page's reporting currency: pick **GBP** to keep pounds. It also asks who can
view; let it create the **Analytics Hub Viewers** group, or name your own.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.4.1`, which the
Azure install pulls.

### Changed: one reporting currency, US dollars by default

**What changed.** The Fabric App's Value page used to show costs in dollars and value in pounds.
Return on cost and the break-even hourly rate stayed blank until someone saved a pounds-per-dollar
rate (#173).

- **One currency.** The whole Value page now uses one reporting currency: US dollars unless another
  is chosen. With dollars nothing is converted and nothing needs setting.
- **Another currency.** Pick it under **Prices** on the Value page (16 common currencies) and give
  how many of it make $1. Licence and credit costs are converted at that rate. The hourly value is
  entered in the chosen currency.
- **Consumption** figures stay in the currency they're billed in, now labelled *as billed*.
- **Installer.** Setup, on both Fabric and Azure, asks for the Value page's currency and an
  optional rate. Nothing is looked up online. It saves them in `valuelens-install.json`, passes them
  to the app (`fabric.config.json` on Fabric; `VALUELENS_CURRENCY` and `VALUELENS_EXCHANGE_RATE` on
  the Azure web app), and sets the Power BI model's `Currency Symbol Value` to match.
- **Settings.** The app's settings gain a `currency` value next to the exchange rate: a column in
  the app's SQL database on Fabric, and a field in Table Storage on Azure.

**If you used pounds.** A saved exchange rate with no currency is read as pounds, the old
behaviour, until the installer is run again. The installer defaults to US dollars, so pick
**GBP** in it, or under **Prices**, to keep pounds. A currency saved under Prices always wins.

**Power BI templates.** The manual `.pbit` templates still ship with `£` as `Currency Symbol Value`.
Change that measure in the `Assumptions` table to your currency; #167 tracks the templates.

### New: share Analytics Hub by adding people to one group

**What changed.** Sharing used to take three or four grants across two or three portals for each person.
Now, on both the Fabric and the Azure path, who can view is one Entra security group,
**Analytics Hub Viewers**, and sharing is adding people to it (#172).

- **Installer.** A *Who can view* question creates the group with you as owner, or uses a group you
  name. It also asks who people should ask for access (you by default) and takes an optional https
  request link, such as a My Access package. A **Viewer access** step gives the group **Build** on
  each model the app reads. The new `access` command (**Manage access** in the browser) adds
  viewers or owners and repairs the Build grants.
- **Share in the app.** A **Share** button copies the app link. On Azure, group owners and
  `AnalyticsHub.Admin` add and remove people or groups in the app; it calls Graph as them
  (delegated `GroupMember.ReadWrite.All`), so Graph still enforces ownership. On Fabric it opens
  the group in My Groups.
- **Request access.** People without access see which group to join, a **Request access** link
  and a prefilled email to the contact, instead of "Ask your admin". On Azure the reason is typed:
  not in the group (`NotAViewer`) or no access to the model (`PowerBIAccessDenied`).
- **Azure web app.** Lets in members of the group (through the `groups` claim, or
  `checkMemberGroups` when someone is in too many groups to fit it) as well as the
  `AnalyticsHub.User` app role. New `/api/access` endpoints back the Share panel.
- **Teams.** The install summary and `2. Azure/teams/README.md` cover publishing the package to the
  org app catalog and pinning it for the group with a setup policy.
- **Fabric.** The app item still has to be shared with the group once, by hand; there is no API
  for it. After that, membership is enough.

Unaffected: the Power BI template variants (CSV, SharePoint, Power Automate + Dataverse), which share
through Power BI. Scoped views, named queries and delegated access come in later phases of #172.

### Fixed: scheduled refresh blocked by "Data source for Query1" on the SharePoint template

**What changed.** After publishing `ValueLens - SharePoint.pbit`, the Power BI service refused to
schedule refresh: *"the following data sources currently don't support refresh: Data source for
Query1"*. The service only schedules a `Web.Contents` source whose URL is a parameter with a value.
`ProductFeedback` built its URL with `Text.Trim(#"Feedback File")`, and a blank optional file
parameter is never a valid source URL either.

- **SharePoint.** A new required **SharePoint Site URL** parameter. `Agent 365` and `Feedback File`
  are read through it with the SharePoint REST API (`ValueLensSharePointFile`), so they can stay
  blank or be set. They must be in that site. Republish and set credentials for each listed source.
- **Power Automate + Dataverse.** The same optional **SharePoint Site URL** parameter reads the
  optional files and the CSV fallback. Dataverse reads use `Dataverse URL` directly as the base URL.
  For scheduled refresh, set both URLs (the same value if you use only one source).
- **Local CSV.** `ProductFeedback` takes the parameter directly, the same as the other templates.
- `scripts/Update-Template-Refresh-Sources.py` applies the change (`--check` reports stale templates),
  and `tests/test_template_refresh_sources.py` fails on any computed or optional base URL.

Tested in the Power BI service with sample CSVs in a test SharePoint site: no refresh banner, the
schedule turns on, and on-demand refresh succeeds with the optional files blank and set, and in
Power Automate CSV fallback.

---

## 2026-10-09 — Analytics Hub installer 0.4.0

**Update an existing install:** download installer 0.4.0, open it and choose **Repair or change**.
To turn on the new optional sources, tick **Defender (shadow AI and agent risk)** or **Agent
configuration and Foundry (Azure Resource Graph)** there, and grant the permissions or roles the
installer lists.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.4.0`, which the
Azure install pulls.

### New: Defender shadow AI and agent risk (optional)

**What changed.** A new optional data source, **Defender (shadow AI and agent risk)**, off by default,
on both the Fabric and the Azure path (#160). It reads Microsoft Defender through Microsoft Graph:
advanced hunting (`POST /security/runHuntingQuery`, `ThreatHunting.Read.All`) and Cloud Discovery in
Defender for Cloud Apps (`CloudApp-Discovery.Read.All`). Fabric runs the new
`Copilot_Defender_Ingester` notebook; Azure runs the `defender` jobs module. Both share
`valuelens_core.defender`, and `V003__defender.sql` creates the Azure SQL tables.

- **Shadow AI on the Governance page.** AI tools other than Copilot that people ran, reached on the
  network or installed on Defender-onboarded devices, plus generative AI apps from Cloud Discovery.
  Tools come from an editable watchlist (`defender/ai_watchlist.csv`), each *Sanctioned*,
  *Unsanctioned* or *Not reviewed* (the default). The section shows with or without the Agent 365
  registry, and says how to turn Defender on when it's off. It is a floor, not a census.
- **Fail-soft probes.** Device activity, installed software, AI agents and Cloud Discovery run on
  their own. One the tenant isn't licensed for, or can't read, is logged in `defender_status` and
  skipped; the rest of the load, and the rest of Governance, carry on, and the page names what
  didn't load.
- **Agent risk.** The two Fabric templates' `Agents 365` table gains `Sign-in Required` (*Yes*, *No*
  or *Unknown*). It takes the first source that knows the agent, Defender's agent inventory for now,
  so a more direct source can go ahead of it. *No* adds a **No sign-in required** governance flag.
- **A weighted review queue.** Flags now carry weights (*No sign-in required* and *Owner has left*
  3, *Org-wide with org data* and *No owner on record* 2, *Shared, no recorded use* 1), and the queue
  sorts by their sum, then flag count, then users.
- **Installer.** A *Defender (shadow AI and agent risk)* choice on both targets (`--data
  defender=api`), the optional permissions, a licence prerequisite (Defender for Endpoint P2, Defender
  XDR or Defender for Cloud Apps) and the `EnableDefender` pipeline parameter.

### New: agent configuration and Foundry from Azure Resource Graph (optional)

**What changed.** A new optional data source, **Agent configuration and Foundry (Azure Resource
Graph)**, off by default, on both the Fabric and the Azure path (#162). Fabric runs the new
`Copilot_Resource_Graph_Ingester` notebook; Azure runs the `resourceGraph` jobs module, and
`V004__resource_graph.sql` creates the Azure SQL tables.

- **Agent configuration.** Copilot Studio agents from `PowerPlatformResources` (authentication,
  connectors, sharing, model and channels), Power Platform environments and agent flows. Resource
  Graph returns agents only to an identity with an Entra role such as Global Reader, so when it
  returns none the load reads the newest file from the new **Analytics Hub - Agent inventory** flow,
  which calls the Power Platform inventory API with a delegated sign-in.
- **Sign-in Required, Resource Graph first.** The `Agents 365` sign-in lookup now asks Resource
  Graph's agent configuration before Defender's agent inventory, so *No sign-in required* works with
  either source. The review queue weights are unchanged.
- **The Foundry estate.** Foundry accounts and projects across the management group (or the whole
  tenant), with public network access and region, on the Governance page. The Consumption page
  joins them to Azure AI spend on resource ID to show spend per Foundry project.
- **Fail-soft probes.** Each probe runs on its own and records what it couldn't read, and why, in
  `arg_status`. The Governance page shows empty states that say how to turn the source on.
- **Installer.** An *Agent configuration and Foundry* choice on both targets (`--data
  resourceGraph=api`, `--arg-management-group`), the Reader role assignment (or the command to run),
  the optional flow, and the `resourceGraph` module on Azure.

### New: Fabric App concentration, value by habit, agent spotlights and chart actions

**What changed.** More additions to the Fabric App, for both the Fabric and Azure paths (#163).

- **Concentration.** Leaderboards, Consumption's Copilot Studio section and Value show the share
  taken by the top 1%, 5% and 25% of people, with a Pareto curve. A share is shown only when its
  slice covers at least five people.
- **Value by habit.** Value has a new section with expert-equivalent hours per person last month
  for Power, Habitual, Developing and Beginner users, labelled as a comparison, not a cause.
- **Agent spotlights.** The agent leaderboard opens with the most used agent, the one used by the
  most job functions, and the one reached across the most organisations.
- **Chart actions.** Every chart's menu has **Copy as image** (it downloads a PNG where the
  clipboard is blocked) and **Download CSV**.
- **Data freshness.** Each page lists the latest date each of its sources holds.

The Power BI templates are unchanged; #167 tracks porting the read-only visuals to them.

### New: Fabric App budget runway, chart headlines and heavy users without a licence

**What changed.** Three additions to the Fabric App, which serves both the Fabric and Azure paths
(#163).

- **Budget runway.** On Consumption, **Monthly budgets** sits next to Rates & packs. It takes an
  optional monthly budget for Cowork / Work IQ, Copilot Studio and Azure. A new *Budget runway*
  section shows each source's spend so far this month against its budget, projects the month-end
  in a straight line, and says whether it is on track, at risk (with the date it would pass the
  budget) or already over. The budgets are stored with the rates: in the app's SQL database on
  Fabric, and in Table Storage through `/api/settings` on Azure.
- **Chart headlines.** Most charts now have one plain sentence above them, worked out from the
  rows they draw, such as the largest category and its share or the peak week. A headline is left
  out when the data is too thin to support one, and it never claims a cause.
- **Heavy users without a licence.** Readiness has a new section that splits last month's active
  people by habit (Power, Habitual, Developing, Beginner) and by licence, and lists the ten
  unlicensed people active on the most days.

The Power BI templates are unchanged.

## 2026-10-09 — Analytics Hub installer 0.3.9

**Update an existing install:** download installer 0.3.9, open it and choose **Repair or change**.
On Azure, run `update` first if you want to load more audit history: older job images ignore
`VALUELENS_AUDIT_BACKFILL_DAYS`.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.9`, which the
Azure install pulls.

### Docs: a disclaimer in the README

**What changed.** The README has a short **Disclaimer** section above *Pick a path*, and each path
README points to it. It says two things. ValueLens isn't the official Copilot report: that's the
Microsoft 365 admin center Copilot usage reports and the Viva Insights Copilot Dashboard, and
because ValueLens reads mainly the Purview audit log its numbers may not always match them. And
once data is extracted into Fabric, Azure, Dataverse, SharePoint or CSV files, the retention,
deletion and other policies set in the source systems don't apply to those copies, so managing
them is up to you.

### New: Repair or change can load more audit history

**What changed.** Once the first load has finished, **Repair or change** asks *Load more audit
history?* and offers only more than is loaded (90 or 180 days after 30, for example); keeping what
you have is the default (#158). The plan shows the reload, which runs once straight after the
repair; later runs load only what's new. The record keeps the larger figure once the reload has
started. This works for Fabric and Azure installs, in the terminal and in `--ui`. On the `--ui`
home page, the **Run** row also gets an **Audit history** picker, and the installed record shows
how much history is loaded. `run --backfill-days <n>` still works.

On Azure, the reload starts the run job once with the new `VALUELENS_AUDIT_BACKFILL_DAYS` setting,
leaving the job's usual settings alone. Job images older than this release ignore it, so run
`update` first.

### New: a Prerequisites check on the installer's home page

**What changed.** After you sign in, the home page shows a **Prerequisites** panel: the roles,
licences, capacities and access the install needs, each as met, missing, eligible or couldn't
check, with what it's for and how to get it. It checks the consent roles (Global or Privileged Role
Administrator), Fabric and Power Platform administrator, app registration, Power BI Pro, Fabric
capacities, Azure access per subscription (Owner, or Contributor plus User Access Administrator),
Key Vault, System Administrator in each Power Platform environment, and the Fabric tenant settings.
Only active roles count; a role you're eligible for in Privileged Identity Management shows as
**eligible, activate first**. Everything is read-only. In the terminal, run `prereqs`.

### Fixed: Repair failed with `FlowMissingConnection` when a flow had changed

**What changed.** Dataverse refuses to update a flow while any of its connections is still to be
signed in to (400 `0x80060467 FlowMissingConnection`), even when the flow is off. So **Repair or
change** failed on a flow created by an earlier version whose connections were never signed in to,
when the new version changed it. Now a flow with no connections signed in to is replaced with the
new version. Bindings made in the Power Automate designer are recognised and kept. A flow that gains
a connection is turned off first, and replaced if Dataverse refuses the update.

### Changed: Product feedback's Power Automate route is its own choice

**What changed.** Product feedback now offers **Power Automate (emailed export)** next to
**Upload CSV** and **Skip**, rather than a yes/no question after Upload CSV. It creates the flow that
saves the exports emailed to a mailbox. The plan, the Data sources screen in `--ui` and the README
show it as its own mode. On the command line it's `--data productFeedback=flow` (or `=api`);
`--feedback-flow` still works and means the same. A saved install that had the flow keeps it.

### New: run the Copilot Studio credits flow now

**What changed.** The Studio credits flow loads its first six months on its first run, which used to
be the next day. Now `run` (in the terminal and in `--ui`) and **Repair or change** check whether
the flow is on and has loaded them yet. If it hasn't, they offer to run it now as you, and to wait
for it so the pipeline that follows picks up its files. On Fabric the check is the flow's
`studio_backfill_done` marker; on Azure, its run history. If the flow is off, or Power Automate
turns the run down, the installer prints the steps to do it by hand and carries on. `--yes` never
runs it. The flows summary after an install says the same.

---

## 2026-10-09 — Analytics Hub installer 0.3.8

### New: credit consumption on the Azure path, with the Studio licensing API as the default

**What changed.** **Credit consumption** can now be ticked on an Azure install (#149), matching what
#150 did for Fabric. The Azure install deploys the Consumption Central model next to the ValueLens
Model, both reading the same Azure SQL database, and the app shows the Consumption Central pages.

- **Copilot Studio credits** come from the Power Platform licensing API by default. The installer
  creates the same daily Power Automate flow as on Fabric: the first run loads about 180 days, later
  runs the last ten, and per-user credits (`studio_user_daily`) are best effort. The flow signs in as
  the person installing; `--flow-identity app` is Fabric only for now, so on Azure it warns and is
  ignored. The PPAC CSV exports remain an option.
- **Where the files land.** With public endpoints the flow writes to the storage account's `landing`
  container (`studio/`, with its own state in `flows/`), and the installer gives the person installing
  **Storage Blob Data Contributor** on the account. With private networking, where Power Automate can't
  reach the storage account, the flow writes to a SharePoint folder you name instead. The jobs'
  managed identity reads it with **Sites.Selected**, which the installer grants if you're a SharePoint
  or Global administrator, or prints the `Grant-PnPAzureADAppSitePermission` command for one.
- **Cowork credits**: drop the Consumption Dashboard's Viva Insights export in the `viva` folder.
- **Azure AI and pay-as-you-go**: the jobs read Cost Management and Azure Monitor with their managed
  identity. The installer assigns the roles on the subscriptions you choose.
- `valuelens-jobs` gains a consumption step that reads the files where they land (it doesn't move them,
  the same as the Fabric notebooks), and a `V002` migration adds the consumption tables.

**Not on Azure yet** (follow-up issues): GitHub Copilot consumption, the dated Agent Daily table, Viva
without a CSV, and `--flow-identity app`.

**Update an existing Azure install:** run installer 0.3.8, choose **Repair or change** and tick
**Credit consumption**. Sign in to the flow's connections when the installer lists them, then turn the
flow on.

Other variants (CSV/SharePoint, Power Automate + Dataverse) are unchanged.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.8`, which the
Azure install pulls.

---

## 2026-10-09 — Analytics Hub installer 0.3.7

**Update an existing install:** download installer 0.3.7, open it and choose **Repair or change**.
If you keep the client secret in the notebooks, run `AnalyticsHubInstaller.exe update` instead:
Repair doesn't rewrite those notebooks.

Both update the Power Automate flows in place and keep the connections already signed in to.
Because the flows now need a OneLake connection, each flow is turned off and the connection to
sign in to is listed. Sign in, then turn the flow back on. A saved choice of *Upload CSV* for
Copilot Studio credits with the flow chosen becomes **Connected**, which behaves the same.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.7`, which the
Azure install pulls.

### Fix: Azure capacity, reconciliation and solution spend pages are blank

**Symptom.** In Consumption Central, **10. Azure: Capacity & Health**, **10.1 Billing:
Reconciliation** and the Foundry solution spend visuals are empty on a real install, even with
Azure OpenAI deployments in the subscription. `AzureAiSpend` and `AzureAiTokens` have rows;
`AzureDeploymentHealth`, `AzureBillingReconciliation` and `AzureSolutionSpend` have none.

**Cause.** Nothing wrote `azure_deployment_health`, `azure_billing_reconciliation` or
`azure_solution_spend`. Only the sample data had them.

**Fix.** `Ingest_Azure_AI` now writes all three after its existing tables, best-effort:

- **Deployment health**, by month and deployment: model, version, SKU, region and PTU capacity
  from ARM, then requests, 429s, 5xx, latency and provisioned utilisation from Azure Monitor. The
  metric calls are batched per account and window, and a failed batch is retried one metric at a
  time. Standard and GlobalStandard deployments have no PTU capacity or utilisation.
- **Solution spend**, by day, resource and service: actual and amortized cost from Cost
  Management for the AI services and the resources in the AI accounts' resource groups, with
  pay-as-you-go token cost, Monitor tokens and requests, and tags.
- **Billing reconciliation**, by month, service and pool: metered quantity times the public
  Retail Prices API list rate, compared with the actual cost. List prices exclude negotiated
  discounts. Meters with no retail price show as `Unpriced`.

An account, deployment or metric that fails is logged as a `WARNING` and skipped. A table whose
source fails entirely is left as it was, and the existing three tables are unaffected. The
existing Reader, Cost Management Reader and Monitoring Reader roles are enough.

The Local CSV and SharePoint script `pull_azure_ai.py` writes the same three files with the same
logic. The Azure (preview) path has no Consumption Central collector yet, and the Power Automate +
Dataverse flows don't fill these tables; import the script's CSVs there. Speech hours, document
pages and images aren't collected. The reconciliation page's context text still describes the
sample data.

### Change: Power Automate flows write to OneLake as a signed-in person, with no Key Vault

**Symptom.** The installer's flows (`Analytics Hub - Product feedback` and `Analytics Hub -
Copilot Studio credits`) read the app's secret through the Azure Key Vault connector. That
connector needs the vault to allow public network access. Where tenant policy keeps vaults
private, the flows could never run. The installer's advice ("allow public access from trusted
services or use a gateway") was wrong: Power Automate isn't an Azure trusted service, and a data
gateway doesn't help this connector.

**Fix.**

- By default, the flows write to `Files/analytics_hub_uploads` through an **HTTP with Microsoft
  Entra ID (preauthorized)** connection to OneLake (Base Resource URL
  `https://onelake.dfs.fabric.microsoft.com`, Resource URI `https://storage.azure.com`). Whoever
  signs in needs Contributor or higher on the workspace. No secret, no Key Vault connection, and
  the flows now work when the secret is kept in the notebooks.
- `install --flow-identity app` keeps the previous behaviour, for tenants that want writes made
  by the app registration. It needs Key Vault, and the installer warns if the vault is private.
- The private-vault warning now says only what's true, and appears only with `--flow-identity app`.
- The installer's next steps for each flow are short numbered steps, with a tip to sign in with
  a dedicated admin account and add a co-owner.
- The manual-setup product feedback flow (`Manual setup/flows`) uses the same OneLake connection.
- The flow writer accepts any ADLS Gen2 (DFS) endpoint, ready for the Azure path.

### Change: Copilot Studio credits come from the licensing API by default

- **Connected (Power Automate flow)** is now the default for Copilot Studio credits. Admin centre
  exports are optional, and win for the months they cover.
- The flow's first run loads about six months of history; then it restates the last ten days
  each day.
- It fills in environment names, which were blank on API rows.
- It also saves per-user credits by day (`StudioApiUserDaily_*.csv`), best effort, from an
  undocumented API route. `Ingest_Studio` loads them into the new `studio_user_daily` table,
  resolves user IDs to UPNs, and fills `studio_user` for months no export covers.
- Consumption Central and the Fabric App say which Studio figures are dated (API) and which are
  month-to-date snapshots (export).

---

## 2026-10-09 — Analytics Hub installer 0.3.6

**Update an existing install:** download installer 0.3.6, open it and choose **Repair or change**.
Repair sees the changed Agent Evaluator model, redeploys it and refreshes it.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.6`, which the
Azure install pulls.

The README also has a new collapsed note on which agents the Purview audit log covers.

### Fix: Agent Evaluator refresh fails with "Cannot order 'Metric Glossary'[Metric] by [MetricOrder]"

Since 0.3.4 the installer treats refresh warnings as failures. That exposed a warning that was
already there: in the Agent Evaluator glossary, 11 metrics are listed on more than one page with a
different `MetricOrder` on each, so `Metric` can't be sorted by `MetricOrder`.

- Each glossary metric now uses its lowest `MetricOrder`, the same rule the ValueLens glossary
  already follows. The rows, descriptions and page order are unchanged.
- `scripts/Update-Glossary-Sort-Order.py` applies the rule to every shipped template, and
  `--check` reports any template that needs it.
- A new test, `tests/test_dax_sort_by_columns.py`, checks every calculated `DATATABLE` that has a
  sort-by column in the shipped templates. It fails when a value has more than one sort key.
  Only the Agent Evaluator template was affected.

---

## 2026-10-09 — Analytics Hub installer 0.3.5

**Update an existing install:** download installer 0.3.5, open it and choose **Repair or change**.
Repair pushes the new org data notebook when the client secret is in Key Vault. If you chose to
keep the secret in the notebooks, run `AnalyticsHubInstaller.exe update` instead: Repair doesn't
rewrite those notebooks, and `update` writes them with a new secret.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.5`, which the
Azure install pulls.

### Fix: org data load stops with "Cycle detected in manager hierarchy"

**Symptom.** On a tenant whose manager data contains a cycle, the org data notebook
(`Copilot_Org_Data_Direct_Ingester`), and so the nightly pipeline, stops with
`ValueError: Cycle detected in manager hierarchy at '…'` and `copilot_org_data` isn't written.
The Azure path's org collector stops the same way.

**Cause.** The manager-chain walk treated any repeat as fatal. That includes someone who is
their own manager in Entra, which is common for the person at the top of the org.

**Fix.**

- Someone whose manager is themselves is now the top of their chain, with no error, and is no
  longer counted as one of their own direct reports.
- A real loop between people (A → B → A) no longer stops the load. Every row is kept, the chain
  is cut where it loops, and the new `HierarchyError` column says where (for example
  `Cycle detected at 'a@contoso.com'`). It's empty for everyone else. The notebook prints how
  many distinct loops it found and up to 20 examples; the Azure collector logs the same as a
  warning.
- The same rules apply to the Local CSV `Adapt-OrgFile-To-EntraUsers.py` adapter, which also
  gains the `HierarchyError` column. The Workday lander's standalone mode adds the column empty so
  its output keeps the same shape.

The report templates don't need changing: they ignore org columns they don't use. The table is
written with `overwriteSchema`, so the new column needs no migration.

---

## 2026-10-08 — Analytics Hub installer 0.3.4

This release fixes models that never finished calculating, and lets long first loads on very
large tenants carry on instead of timing out.

### Fix: report pages say a column "needs to be recalculated"

**Symptom.** After installing with 0.3.3, or deploying a 0.3.3 ValueLens template, report pages
fail with *"The expression referenced column '…'[Is Usage Row] which does not hold any data
because it needs to be recalculated"*. The relationship between Audit_UserId and Org Data
PersonId shows the same message. The model refresh still says **Completed**.

**Cause.** The Calendar table named a variable `LastDate`, which the DAX parser rejects. Power BI
only logs that as a refresh warning, so Calendar, `Is Usage Row` and the relationship were never
calculated. The Agent Evaluator template had two more warnings of the same kind: its Metric
Glossary table and its Conversations Shown measure didn't parse.

**Fix an existing install (Fabric):**

1. Download installer 0.3.4 and open it.
2. Choose **Repair or change** and go through the steps. The installer redeploys any model whose
   definition changed (ValueLens, and Agent Evaluator if you have it), connects it again,
   refreshes it and runs a test query against it. The run ends with
   `✓ … answers queries (its Calendar has N days)`.
3. If you run commands instead, `AnalyticsHubInstaller.exe update` does the same.
4. To check later, run `AnalyticsHubInstaller.exe check`. It now also queries the model and fails
   when its tables weren't calculated.

**Fix an existing install (Azure):** choose **Repair or change**, then run
`AnalyticsHubInstaller.exe refresh`. A redeployed model has no data until it refreshes.

**Manual set-up from a template:** download the updated `.pbit`, or open the Calendar table's
DAX in Power BI Desktop, rename the variable `LastDate` to `MaxDay` (it appears three times), and
refresh.

What else changes:

- A refresh that ends **Completed** with a warning or error message now counts as failed, both in
  the installer and in the `AnalyticsHub_Refresh_Model` notebook. So the nightly pipeline fails
  instead of leaving a half-calculated model.
- **Repair** now pushes new versions of the notebooks, such as the refresh notebook and the
  ingesters below. Before, only `update` did. Notebooks that hold the client secret inline (no
  Key Vault) still need `update`, because writing them needs a fresh secret.
- CI rejects DAX variable names that the service rejects
  ([tests/fixtures/dax_reserved_names.txt](tests/fixtures/dax_reserved_names.txt), built by
  asking the service) and string literals with an unescaped quote.

### Fabric: long first loads on very large tenants carry on instead of timing out

- The **first load now defaults to 30 days** of audit history (the notebook was 180, the installer
  90). You can still choose up to 180 days, or load more later with `run --backfill-days <n>`.
- The **audit ingester** stops cleanly before its activity time limit (`TIME_BUDGET_MIN`) and saves
  where it got to. The next run or the pipeline retry reuses queries the audit service is still
  working on, and skips recent windows it finished in the last few hours, so nothing is queried twice.
- The **Licensed users** and **Org data** ingesters retry Microsoft Graph throttling (429), server
  errors and dropped connections, honour `Retry-After`, and renew an expired token once.
- The installer asks **how many people are in the tenant**, prefilled from the capacity size:
  - **Up to 10,000** uses 24-hour audit windows (about 8 queries a day instead of 22) and keeps the
    template timeouts.
  - **More than 10,000** uses 2-hour windows that the audit service can finish, gives up on a failing
    window after one retry, splits it sooner, and gives the longer activities more time.
  - An existing install keeps 8-hour windows and its timeouts until you choose **Repair or change**.
- The first-load message gives a realistic estimate instead of "10 to 40 minutes", and the
  missing service principal message says **Carry on anyway** creates it.

The first daily run after you pick a size re-queries the trailing week once, because the windows
change size. A first load in progress restarts its windows at the new size.

---

## 2026-10-08 — Analytics Hub installer 0.3.3

The installer bundles the notebooks, templates and app when it is built, so this release brings
everything merged since 0.3.2 to installer users:

- set-ups **without Key Vault write access or app registration rights**: a vault admin adds the
  secret, an admin pack for app registration, and a check of a bring-your-own app (#138);
- the **audit ingester** retries, splits and throttles failed query windows instead of stopping
  the run (#137);
- Cowork scheduled runs counted, an **Update your install** prompt when the install is older
  than the app, and empty-source fixes (#136).

The audit ingester's manifest gains a `split` window status, and older copies of the notebook
reject a manifest that contains one. Don't roll back to an earlier installer or notebook in the
middle of a backfill.

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.3`, which the
Azure install pulls. To update, download the installer again, open it and choose
**Repair or change**.

---

## 2026-10-08 — Analytics Hub installer: set-ups without Key Vault write access or app registration rights

Until now, the installer stopped with `You can't write secrets to …` when you could pick a vault
but not write to it, and needed you to register the app yourself or bring one that was ready.
In a large tenant, those rights often sit with someone else. The existing paths haven't changed.
The new ones are:

- **A vault admin will add the secret for me.** This is offered when you can't write to the
  vault. The installer shows the vault, the secret name and one Azure Cloud Shell command. The
  command creates the client secret and stores it in the vault, so its value never reaches the
  installer. You only need read access (Key Vault Secrets User, or Get and List on an access
  policy), which is all the notebooks need to read the secret at run time. The installer can
  make the admin an owner of the app. You can stop and resume later. `rotate-secret` gives the
  same handoff. It's recorded as `keyVault.mode: "keyvault-admin"`.
- **Store the secret in the notebook (not recommended).** For quick tests only. It needs no
  Azure subscription or vault. You have to confirm a warning first: the secret is plain text,
  anyone with workspace access can read it, and it is copied into run snapshots, exports, Git
  sync and deployment pipelines. `install --secret-in-notebook` chooses it with `--yes`.
  Rotating creates a new secret, rewrites the notebooks and removes the old secret. Power
  Automate flows are skipped. It's recorded as `keyVault.mode: "notebook"`.
- **Contributor on one resource group** is enough for a new vault. If the installer can't read
  the subscription's resource providers, that's no longer fatal. It uses an existing group
  instead of trying to create it, and explains a 403 or an unregistered `Microsoft.KeyVault`
  provider.
- **Admin pack.** If you can't register apps or grant consent, choose **An admin will register
  the app for me**. You get `analytics-hub-admin-pack.md`, which has a Cloud Shell script and
  portal steps covering every Graph permission your modules need, admin consent and the secret.
- **Bring-your-own app check.** An app you bring is checked before anything is created: its
  service principal, its Graph permissions and admin consent. You get a list of what's missing,
  the consent link, and the choice to **Check again** or **Carry on anyway**.

Both the terminal and the web UI support all of these. See
[Where the secret goes](installer/README.md#where-the-secret-goes).

---

## 2026-10-08 — Audit ingester: failed query windows retry, split and slow down

On large tenants, Purview sometimes ends audit-log queries with status `failed` or `cancelled`,
often several at once, when the tenant's limit on concurrent audit queries (about 10, including
searches other admins run in Purview) is reached. Until now, the first failed window stopped
`Copilot_Audit_Log_Direct_Ingester`, nothing was written, and the only way back was a manual
rerun with `MODE = 'backfill'`. Switching to `'incremental'` first lost the older failed windows.

The ingester now recovers by itself:

- **Retry.** A window whose query ends `failed` or `cancelled`, or times out, is sent again as a
  **new** query after an exponential backoff with jitter, up to `WINDOW_RETRIES` (3) times. The
  manifest records `attempts` and the recent `attempt_errors` for each window.
- **Split.** A window that still fails is split in half (8h → 4h → 2h → 1h, down to
  `MIN_CHUNK_HOURS`) and the halves are queried. A window that hits `MAX_WAIT_MIN_PER_QUERY`
  splits at once (`SPLIT_ON_TIMEOUT`).
- **Adaptive concurrency.** After a failure, the run makes one fewer query at a time, and after an
  HTTP 429 it makes half as many. This lasts for the rest of the run, at most one change a minute,
  and never goes below `MIN_CONCURRENT_QUERIES`. `MAX_CONCURRENT_QUERIES` now defaults to **5**
  (it was 6) to leave room for other admins.
- **No early abort.** Every window is attempted, then a summary prints what was reused, fetched,
  retried, split and failed.
- **Safe final failure.** If any window still fails at the smallest size, the run fails **without
  writing**, with one message listing the failed windows and the next step ("rerun with
  `MODE='backfill'`; succeeded windows are reused"). An `'incremental'` run refuses to start
  while an older window failed and was never recovered, so it can't leave a silent gap. Set
  `ALLOW_UNRECOVERED_GAPS = True` to accept the gap. Missing permissions (401/403) still stop
  the run at once.

Manifest compatibility: window keys are unchanged (`WINDOW_KEY_VERSION` stays `v2`), so existing
manifests and their succeeded windows are reused. The halves use the same `stable_window_key` as
any other window. A split window stays in the manifest with status `split` and its `parts`, and
counts as complete once all its parts succeed. A manifest that contains a `split` window is
rejected by older copies of the notebook, so don't switch back after a split.

Other variants:

- **Azure jobs** (`2. Azure/jobs`, also used by the SharePoint Azure container): the same retry,
  split and concurrency behaviour, using the shared `valuelens_core.audit` helpers. As before,
  windows that finished are merged and the high-water mark holds until every window succeeds.
  The job now lists the failed windows (up to 10).
- **`Invoke-CopilotAuditRawCapture.ps1`** (Power Automate + Dataverse): new `-QueryRetries`
  (default 2), `-RetryBaseSeconds` and `-RetryMaxSeconds`. A failed, cancelled or timed-out query
  is sent again as a new query. The script covers one window, so it doesn't split.
- Not affected: the Power Automate / PAX collector flows, SharePoint without Azure, and Local
  CSV. They export audit data with Microsoft's tools rather than run these queries.

See [An audit window keeps failing](fabric/notebooks/README.md#an-audit-window-keeps-failing).

---

## 2026-10-08 — Cowork scheduled runs, install version checks and empty-source fixes

Fixes from a data audit of a customer install.

**Cowork scheduled and autonomous runs are counted (P3).** These runs log a record with no
prompt, so every parser dropped them and their users never appeared in Adoption or Executive,
even though Viva Insights billed their credits. They are now kept as one task row per record
(`Message_isPrompt` FALSE, `message:none`, no resource fan-out), the way Copilot Studio runtime
records already were. In the model:

- a hidden `Is Usage Row` column (`Is Prompt Row` or `Is_Cowork`) and `Usage Rows` measure;
- `All Active Users`, `Active Licensed Users`, `Active Unlicensed Users` and `Cowork Users` count
  people with a usage row, so a person whose only use was a scheduled run is an active Cowork user;
- a new `Cowork Scheduled Runs` measure;
- `AI Tasks`, prompts, sessions and Cowork Fit stay prompt-only. Per-user session and prompt
  averages now include people whose only use was a scheduled run.

| Variant | Change |
|---|---|
| Fabric | Audit ingester notebook; both Fabric templates; the Fabric App's org-coverage count |
| Azure | `valuelens_core` DuckDB port (which now also keeps Copilot Studio runtime records, matching Fabric) |
| Local CSV | `Purview_CopilotInteraction_Processor_v4.0.0.py` (aibv profile) and template |
| SharePoint | Template. The scheduled path flattens with the upstream PAX processor that `Run-PAX-AIBV.ps1` downloads, so that needs a PAX follow-up; installs that run the Local CSV processor get the fix |
| Power Automate + Dataverse | `Build-DataverseCoreFeeds.py` and template |

**The app says when the install is older than the app (P1).** Pages that need newer model
columns, starting with Governance and the Agent 365 columns from #130, probe for them first. If
any are missing, the page shows **Update your install** and lists them, instead of four query
errors. Requirements are listed in one place (`src/lib/model-requirements.ts`), and any query that
fails on a missing column or table shows the same guidance. *Fabric App and installer only.*

**Optional modules left off are "not configured" (P8).** The installer now writes the chosen
modules into the app's `fabric.config.json`. A module that is off hides its pages, as an empty
source already did (#129), and the Feedback page explains it isn't set up rather than saying
"No feedback data". Installs without the field keep the data probe. *Fabric App and installer
only.*

**The Calendar covers more than the audit (P7).** It runs from the earliest to the latest of the
audit and product feedback dates, and on installer-built Fabric models the M365 Activity dates.
With none of them it holds the last 365 days, so date-sliced M365 and feedback visuals work before
the first audit load. *All five ValueLens templates, and the Fabric installer for M365 Activity,
which only it adds.*

**A blank or 0 Cowork limit means no limit (P9).** Allowance and headroom are blank, and nobody
is over or near the limit, instead of a negative headroom and everyone over. The app's Cowork
section shows **No limit set**. *All four Consumption Central templates and the Fabric App.*

**The Agent Evaluator writes empty tables in merge mode (P6).** With no transcripts and no
existing tables, merge and append now create the `dbo.agent_*` tables with their schema, as
overwrite does, and the log says what happened to each table. *Fabric only: the Agent Evaluator
notebooks run only there.*

The template DAX changes are applied by `scripts/Update-Template-Dax.py` (`--check` reports
templates that need it). Refresh a published model after updating its template.

---

## 2026-10-07 — Analytics Hub installer 0.3.2: Azure install fix

Every Azure install with the default settings (images pulled from the public
`ghcr.io/microsoft/valuelens-*` registry) failed at step 2, *Azure resources*, with
`InvalidTemplate: ... 'vl-containerapps' ... array index '2' is out of bounds`.

The template's optional private-registry step (the AcrPull role assignment) took its
subscription and resource group by splitting `imageRegistryResourceId`, and the Container Apps
deployment always depends on it. ARM evaluates those expressions while validating, even when
the step is switched off, so an empty registry id broke the deployment. `2. Azure/infra/main.bicep`
now parses a well-formed stand-in id when no private registry is set; installs that use a private
Azure Container Registry are unchanged.

The installer tests now evaluate the compiled template the way ARM validates it, with the
parameters the installer sends (default, private registry, private networking), so this class of
error fails CI. Previously CI only checked that the template matched the Bicep source and that the
parameter names and types lined up.

The tag publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.2`. To update, download
the installer again, open it and choose **Repair or change**.

---

## 2026-10-07 — Analytics Hub installer 0.3.1

The installer bundles the notebooks, templates and app when it is built, so this release brings
everything merged since 0.3.0 to installer users:

- the **Power BI reports**, published and connected to the semantic models (#128);
- the Fabric App's **Governance** page (#130), pages hidden when their optional source has no
  data (#129), and the Feedback card height and heatmap contrast fixes (#133);
- the Agent 365 registry ingester that checkpoints and resumes on large tenants, and no longer
  fails on agents with no detail (#131, #132).

The tag also publishes the `valuelens-jobs` and `valuelens-web` images as `0.3.1`, which the
Azure install pulls. To update, download the installer again, open it and choose
**Repair or change**.

---

## 2026-10-07 — Agent 365 registry: agents with no detail no longer fail the run

On large tenants, some agents' detail calls fail every time, typically with HTTP 424 *Failed
Dependency* on that package, and there can be more of them than the missing-detail tolerance
added in the previous entry allowed (25 agents or 0.5% of the catalogue). The run then failed,
even though every other agent's detail had been fetched.

The tolerance is gone. In the Fabric ingester (`Copilot_Agent365_Registry_Ingester.ipynb`) and
`Get-Agents365Registry.ps1`:

- **Any agent whose detail call fails is written list-only**, whatever the reason: 424, 404,
  403, or a 429, 5xx or network error after retries. Its list fields are kept, and the usage,
  Bot Id and capability columns are blank. In Fabric, `Detail status` records the reason, for
  example `missing (HTTP 424)`. The run prints a warning counting these agents by reason.
- **These agents are never cached, so every run retries them.** 424 and 404 are not retried
  within a run. An agent with cached detail still falls back to it (`cached - refetch failed`).
- **One safety net remains:** if every detail call failed with 401 or 403 and there is no cached
  detail, sign-in or consent is broken, so the run fails without writing rather than replacing
  the registry with one that has no detail at all.
- `MAX_MISSING_DETAIL` / `MAX_MISSING_DETAIL_PCT` and `-MaxMissingDetail` / `-MaxMissingDetailPct`
  are removed. A notebook whose config cell still sets them runs unchanged; the values are ignored.
  Scripts or scheduled tasks that pass the PowerShell parameters must drop them.

Also fixed: **`Last updated` no longer flips between runs.** For a few agents per tenant, the
detail payload's `lastModifiedDateTime` differs from the list's. A freshly fetched agent took the
detail's stamp and a cached one took the list's, so `Last updated`, which is part of the
`agents_365_history` key, changed whenever an agent moved between fetched and cached. Each change
added a duplicate history row: 499 rows for 495 agents after three runs on one test tenant.
`Last updated` is now always the list's stamp (the one change detection keys on), falling back to
the detail's only when the list has none. This applies to the notebook and the PowerShell script.
History rows already written are left as they are.

To pick it up, re-import the notebook (or update the script) and rerun it. If you patched the
detail loop by hand to skip 424s, drop that patch: the updated notebook handles them. See the
[data dictionary](docs/DATA-DICTIONARY.md).

---

## 2026-10-07 — Agent 365 registry: first runs on very large tenants resume instead of starting over

On a first run there is no detail cache, so a tenant with ~20,000 agents makes ~20,000 detail
calls. Before this change, one failed call among them failed the whole step, the cache was
written only at the very end, and so every successful fetch was thrown away. The next run then
started from zero again. The step 4 cell then failed with `NameError: name 'details' is not
defined` instead of saying what went wrong.

The Fabric ingester (`Copilot_Agent365_Registry_Ingester.ipynb`) and its PowerShell twin for the
CSV, SharePoint and Power Automate + Dataverse templates (`Get-Agents365Registry.ps1`) now:

- **Checkpoint the detail cache during the fetch** (every 1,000 successful calls, and again if
  the run fails), so a rerun fetches only what is still missing. Checkpoints hold only freshly
  fetched detail, so a changed agent is never marked as seen with stale data.
- **Retry network timeouts, dropped connections, 500 and 502** with the existing backoff, as
  well as 429, 503 and 504.
- **Tolerate a few agents with no detail**, for example a 404 or 403 on one package: up to 25
  agents or 0.5% of the catalogue, whichever is larger. These agents are written list-only and
  retried next run. In Fabric they carry a new snapshot column, `Detail status` = `missing`. An
  agent whose refetch fails keeps its cached detail. Above the tolerance the run fails clearly,
  listing the failure reasons, and leaves the previous registry in place.
- **Print the expected duration and progress with an ETA** every 500 calls.
- **Guard each notebook step**, so a failed step stops later cells with a message naming it.

To pick it up, re-import the notebook (or update the script) and rerun it; if the run is
interrupted, run it again and it resumes from the cache. The 48-column CSV contract is
unchanged. See the [data dictionary](docs/DATA-DICTIONARY.md).

---

## 2026-10-07 — Analytics Hub app: pages without data no longer appear

The app (Fabric and Azure) now checks the ValueLens model's optional sources when it opens, and
leaves out what would be blank:

- **Feedback** is hidden until `ProductFeedback` has rows, and **Work patterns** until
  `M365 Activity` does. Links to them (the Executive summary's attention items, page footers)
  disappear too, and the Executive summary drops its Satisfaction card.
- Without Agent 365 registry data, **Governance** shows one *Connect the Agent 365 registry* state
  instead of four empty sections. **Leaderboards** keeps the agent usage and leaderboard, drops the
  registry-only columns, and drops its link to Governance.
- The check is unfiltered, so a filter that empties a page never hides it. If the check fails for
  any reason other than a missing table, everything stays visible.

---

## 2026-10-07 — Analytics Hub installer: the Power BI reports

The installer can now publish the reports from the Power BI templates, already connected to the
semantic models it deploys: `ValueLens`, and `Consumption Central` and `Agent Evaluator` with their
modules. It's the new default for Power BI, alongside the model and the app, so nobody needs Power BI
Desktop. The plan lists the reports, and the summary links to them.

A new installer version that brings a changed report asks before replacing it, because that
replaces edits made in Power BI. A report that can't be published is reported, and the rest of the
install carries on. If you're a Fabric administrator, the installer also checks the tenant setting
*Allow visuals created using the Power BI SDK*, which the Tornado chart, Word cloud and Deneb
visuals need. See [Power BI reports](installer/README.md#power-bi-reports).

An earlier install gets the reports offered the next time you choose **Repair or change**.
Installer users get this in the next installer release.

---

## 2026-10-07 — Analytics Hub installer 0.3.0: the Azure target, and demo mode

This is the first release that can install Analytics Hub in **your own Azure subscription**
instead of Fabric (preview, see [2. Azure](azure/README.md)). Pick **Your Azure subscription**
as the first wizard answer. The tag also publishes the `valuelens-jobs` and `valuelens-web`
images to `ghcr.io/microsoft` with the same version, which the Azure install pulls.

- **Demo mode (sample data).** After the data tick boxes, the Azure wizard asks whether the
  dashboard shows your tenant's data or a synthetic sample. Demo mode deploys everything as usual,
  but each run publishes the sample bundled in the jobs image, moved forward to end last week.
  Run the installer again and pick your tenant's data to switch.
- The Fabric App's page canvas has one scrollbar instead of two (#125), for both targets.

To update a Fabric install, download the installer again, open it and choose **Repair or change**.

---

## 2026-10-07 — Paths renumbered: Azure second

The Azure path (preview) joins the numbered paths, second after Fabric, because it's the other
route that installs everything for you:

| Was | Now |
|---|---|
| `5. Azure` | `2. Azure` |
| `2. Power Automate + Dataverse` | `3. Power Automate + Dataverse` |
| `3. SharePoint` | `4. SharePoint` |
| `4. Local CSV` | `5. Local CSV` |

`1. Fabric` is unchanged. Only paths changed: links, the CI workflows, the Dockerfiles, the tests and
the installer all point at the new folders, and the older entries below use the new paths so their
links keep working. Released installers are unaffected, because they bundle what they deploy rather
than downloading it from the repo. Bookmarks and links from outside the repo to the old folder names
will break, because GitHub doesn't redirect renamed folders.

---

## 2026-10-06 — Analytics Hub installer 0.2.5

The installer bundles the notebooks and templates when it is built, so this release brings
everything merged since 0.2.4 to installer users:

- the **Data sources** screen, with the API, a CSV upload or Skip for every source, one drop
  folder for CSV exports, and product feedback;
- the Viva Insights Dataflow for Cowork credits, the Power Automate flows for product feedback
  and Copilot Studio credits, and the Analytics Hub names;
- agent type, publisher and consolidated name in the audit processor;
- one shared Spark session per run, a card for each source, `dbo.load_log`, **Rerun failed
  loads**, the SQL endpoint sync before the model refresh, and a data check that explains an
  empty Copilot interactions table;
- the Fabric App's Executive summary page.

To update, download the installer again, open it and choose **Repair or change**.
---

## 2026-10-06 — Analytics Hub installer: fewer busy-capacity failures, and clearer ones

- **One Spark session per run.** The pipeline's notebooks now share a high-concurrency Spark
  session, instead of each starting its own. Small capacities are much less often too busy to
  start them (`TooManyRequestsForCapacity`). The installer turns the workspace setting on; that
  needs the workspace Admin role, and without it the installer warns and carries on.
- **A card for each source.** After a run, the installer says which sources loaded, failed,
  were skipped or are still running. A failure says why in plain words, such as a busy capacity,
  a sign-in problem, a timeout or a missing export, and what to do.
- **`dbo.load_log`.** A new last pipeline step, `AnalyticsHub_Load_Status`, records the same
  thing in the Lakehouse, one row per source per run. It fails the run when a load failed, so
  Fabric's run history and alerts show it.
- **Rerun failed loads.** A new command and button runs only the loads that failed, and the
  steps and refreshes after them. It waits and tries again while the capacity is busy, and so
  does the data check after a run.
- **The model refresh waits for the SQL endpoint.** `AnalyticsHub_Refresh_Model` now asks the
  Lakehouse SQL endpoints to sync before it refreshes the model. Before, a refresh straight after
  a load could fail with *Table '…' is not in database*. If it still happens, the card says so
  and suggests a rerun.
- **An empty Copilot interactions table says why.** When the audit log only held test or admin
  activity, such as Copilot Studio test runs (*Maker evaluation*), the Audit Log Processor leaves
  all of it out and the table is empty. The data check now counts what was left out and why,
  instead of just reporting 0 rows.

Installer users get this in the next installer release.

---

## 2026-10-06 — Analytics Hub installer: a Viva Insights Dataflow, Power Automate flows and new names

- **Cowork credits** can come straight from a Viva Insights query. Choose **Connected (Dataflow)**
  and give the partition and query IDs. The installer creates the Dataflow Gen2
  `AnalyticsHub_Cowork_Credits`, and the pipeline refreshes it before each Viva load. The CSV
  export is still the fallback. `Ingest_Viva_Consumption` reads both, and the Dataflow wins for
  weeks both cover.
- **Copilot Studio credits** can come from the Power Platform licensing API. An optional flow,
  `Analytics Hub - Copilot Studio credits`, saves the last ten days by agent each day.
  `Ingest_Studio` loads them into the new `studio_agent_daily` table, and fills the tenant and
  agent views for days and months no export covers. It only sees environments with credits
  allocated, and exports still add per-user figures.
- **The product feedback flow** is now created for you in Power Automate, turned off, instead of
  written to a file to import. Both flows read the app's secret from Key Vault; you sign in to
  their connections and turn them on.
- **New names.** A new install calls its items Analytics Hub: `Analytics Hub Model`,
  `AnalyticsHub_Pipeline`, `Analytics Hub SQL …` and `Analytics Hub Data Collector`. Existing
  installs keep their names.

Installer users get this in the next installer release.

---

## 2026-10-05 — Task time estimates cite peer-reviewed sources

The `Human Time Estimates` table in all five templates now cites peer-reviewed studies or major
research institutions, such as Noy & Zhang (*Science* 2023), Brynjolfsson et al. (NBER) and
Microsoft Research CHI papers, instead of vendor surveys, blogs and landing pages. Links are DOIs
where one exists. Rows with no credible time study now say *Provisional estimate*, have no link
and are rated Low. No confidence went up, and no minutes changed, so value and hours-saved figures
are the same. The Fabric App reads the new sources from the model. Installer users get this in the
next installer release.

---

## 2026-10-05 — Analytics Hub installer 0.2.4

The installer bundles the notebooks and templates when it is built, so this release brings
everything merged since 0.2.3 to installer users: the plain-English task descriptions and App host
in the glossary, one name for each task level, the review fixes below, agents linked even when they have no name, and an incremental Agent 365
registry pull. It also stops the installer overwriting another install's client secret in a Key
Vault you already have.

To update, download the installer again, open it and choose **Repair or change**.

---

## 2026-10-05 — Analytics Hub review fixes

**Templates, all four paths, and the Fabric App.**
- **🌱 Habit Formation** follows the date filter. Stages use the most recent complete month in
  the selected dates, capped at the last complete month in the data. Before, they always used the
  last complete month, whatever dates were picked. Inactive is now blank for Unlicensed users and
  Agents as well as Cowork, since none of them have a seat to measure against. The app says so,
  and shows a message instead of a trend when the dates cover fewer than two months.

**Consumption Central add-on, all four paths.** Models named from Azure meters are spelled the
way OpenAI writes them: GPT-4o, o4-mini, GPT-5.4, GPT-4.1 and GPT-5, not "Gpt 4O", "O4 Mini" and a
bare "5.4". Other meters, such as Pay As You Go Copilot Credit, keep their names. The app's Cost
by model and Foundry resources views show the new names even before the template is updated.

**Fabric App.**
- **Feedback** counts only feedback dated inside the Calendar, as its weekly trend always did.
  Feedback sent outside the report's dates no longer inflates the totals, satisfaction, topics
  and surfaces.
- **Cowork fit** with License set to Unlicensed says Cowork needs a Copilot license, the same as
  the Cowork leaderboard does, rather than suggesting there's no Cowork activity yet.
- **Agent registry** keeps its side panel below the table until the window is extra wide, so the
  table's columns aren't squeezed on a laptop screen.

**Agent Evaluator add-on.** **Knowledge Answered Rate** is now a share of knowledge searches, the
complement of **Knowledge Gap Rate**, so the two add up to 100%. It used to divide by every
session, so the Knowledge Gap focus card understated how often searches found an answer. The
card's content gap is now the Gap Rate itself.

**Fabric installer.** In a Key Vault you already have, the installer no longer overwrites another
install's client secret. If the secret name is taken by a secret that isn't this app's, it is
left alone and the new secret goes in the next free name, such as `valuelens-client-secret-2`.

## 2026-10-05 — One name for each task level, and Fabric App review fixes

**Templates, all four paths.** Every page now calls the 12 task groups **Task Category** and the
detailed tasks **Task Breakdown**. Before, Estimated Value said Category and Task, and the
Leaderboard said task group and task category. Engagement charts say **Engagement mode**. The
**🧬 Appendix: Signal → Impact** table adds a plain-English **Description** of each task, and the
**📖 Metric Glossary** explains App host and why it makes the task mix indicative. Download the
template again to get these. The installer picks them up in its next release.

**Fabric App.**
- The filter bar alone picks Licensed, Unlicensed, Agents or Cowork. The pages' own Cohort
  switches, which could disagree with it, are gone.
- Work patterns: an org filter no longer inflates active days or drops weeks from the trend.
- Feedback: feedback with no date stays out of the weekly trend.
- Consumption: Cowork credits name each person, instead of one "(No value)" row.
- Value: a return just below 1x shows as a loss, such as 0.97x in red, never as break-even.
- Adoption: the Activation headline reads as one sentence.
- Tables fit their headers, date slicers say Date, and the Value task chart's switch reads
  "Break down by".

---

## 2026-10-05 — Analytics Hub installer 0.2.3: a busy trial capacity

On a Fabric trial or a small capacity, the first load could fail with `TooManyRequestsForCapacity`.
The pipeline started about six notebooks at once, and Fabric turned some of them away. The pipeline
now runs its notebooks in two lanes, so no more than two run at the same time. If a notebook still
fails, the pipeline waits five minutes and tries it again. If Fabric is still too busy after that,
the installer says so in plain words: nothing is lost, wait a few minutes and choose **Run now**
again.

If this happened to you, download the installer again, open it and choose **Repair or change**. It
offers to update the pipeline and to run the first load again. Until the first load succeeds,
**Run now** runs it again, with the audit history you picked.

---

## 2026-10-05 — Analytics Hub installer 0.2.2: a Key Vault that another workspace already reads

If you picked a Key Vault that blocks public access, and another Analytics Hub workspace already
reads it, the installer mistook that workspace's approved connection for its own. It never approved
the new one, waited 20 minutes, and stopped at **Workspace and Lakehouse** with "Waiting for Fabric
to see the approval for more than 20 minutes". It now finds its own connection by the workspace ID
and approves it.

If this happened to you, download the installer again, open it and choose **Repair or change**. It
approves the waiting connection and carries on.

---

## 2026-10-05 — Analytics Hub installer 0.2.1: Back, and Lakehouse names with spaces

Every question now has a **Back** button, and so does the plan. Back opens the previous question
with your answer filled in, and the questions after it are asked again. Going back reuses what the
installer already looked up in your tenant, so it's quick. If you go back to the client secret, an
empty box keeps the one you pasted. If you go back further, you'll be asked for it again. The
secret still isn't saved in the install record or shown on the page.

The Lakehouse name now takes spaces and hyphens. Fabric doesn't allow them, so they become
underscores, and the installer says so: `My Lakehouse` becomes `My_Lakehouse`.

---

## 2026-10-05 — Analytics Hub installer 0.2.0: tick what to collect

**What to collect** is now a list of tick boxes, and each one says where its data comes from and
what it shows. Copilot usage, licences and org data are always collected, because the dashboard is
built on them. Their boxes are ticked and locked. Microsoft 365 activity is ticked. The Agent 365
registry, product feedback, credit consumption and the Agent Evaluator aren't. Copilot Studio
transcripts are now called **Agent Evaluator**, after the page they feed. An install record that
turned org data off turns it back on, so the next update also updates the pipeline.

The installer is also safe in a workspace that already has things in it. It never changes an item
it didn't create. If one of its names is taken, its own item gets the next free name, such as
`ValueLens_2`, and the plan shows the names before you approve it.

---

## 2026-10-05 — Fabric: one folder for setting up by hand

`1. Fabric` now holds only its README, the installer, the Fabric App and a new
[`Manual setup`](fabric/MANUAL-SETUP.md) folder. Everything for setting up by hand moved into
it: the two report templates, `notebooks/`, `pipelines/`, `flows/` and both add-ons. The add-ons'
notebooks now sit with the others, in `notebooks/credit-consumption/` and
`notebooks/agent-evaluator/`, and the Workday overlay moved from `notebooks/optional/` to
`notebooks/workday-org-data/`. The installer reads the new paths. The published installer exe
carries its own copy of these files, so it isn't affected. Old links to the moved folders no
longer work.

The Fabric README's optional extras now say what each one shows and where its data comes from.

## 2026-10-05 — A leaner repo: simple steps, less clutter

Every path README is now just the steps to follow. The root README is a short path picker, and
the Fabric README walks through the installer exe. The notebooks, pipeline, flows, add-on and
Fabric App READMEs cover only the manual steps they're needed for.

Removed: the archived Fabric templates and extended references (`1. Fabric/archive/`), the
Dataverse path's archive, the Fabric design docs and checker (`1. Fabric/docs/`), the architecture
diagrams, page screenshots, `scripts/sync-shared.ps1` and its workflow, and two one-off fix
scripts. The old Power BI templates are kept, flat, in [`archive/`](archive/). The retired credit
cost table is gone from the [data dictionary](docs/DATA-DICTIONARY.md); its ingester was already
archived and no template read it.

The pipeline still carries its `EnableConsumption` branch, off by default, so existing pipelines
keep working.

---

## 2026-10-05 — Analytics Hub installer: download and double-click

`AnalyticsHubInstaller.exe` runs the installer without Node.js, a terminal or a clone of this repo.
Download it from the repo's releases and double-click it: it unpacks once to
`%LOCALAPPDATA%\AnalyticsHub` and opens the installer in your browser. It carries the notebooks,
pipeline, semantic models and a ready-built Analytics Hub app, and keeps the install record in
`Documents\Analytics Hub`. The app now reads its model IDs from a `fabric.config.json` deployed
next to it, so one build serves every tenant; deploys from a clone still use `fabric.yaml`.
Messages name `AnalyticsHubInstaller.exe` when it started the installer. A new `installer-exe`
workflow builds and smoke-tests the exe, and drafts a release for each `installer-v*` tag. See
[Download and run](installer/README.md#run-it).

---

## 2026-10-04 — Fabric installer: now the Analytics Hub installer

The installer now calls itself the Analytics Hub installer in its README and in the descriptions
it gives what it creates: the app registration's notes and client secret, and the semantic model,
notebooks and pipeline. The command is still `npx valuelens-install`, and the data-side names (the
Lakehouse, notebooks, pipeline and models) still say ValueLens.

---

## 2026-10-04 — Fabric installer: check the data again

The data check isn't part of the pipeline, so the scheduled runs never updated it, and `status`
went on showing what the first load found. `status` now says when the pipeline has run since the
last check, and `npx valuelens-install check` (or **Check the data** in the browser) runs the check
again on its own, without the pipeline. See [Commands](installer/README.md#without-the-exe).

---

## 2026-10-03 — Fabric installer: in your browser

`npx valuelens-install --ui` runs the installer as a page in your browser instead of the terminal.
It opens on a home page: set up Analytics Hub, or, once it's installed, run the pipeline, refresh
the models, check status, update, redeploy the app, create new secrets, or repair the set-up. The
questions, the plan and each step's progress appear on the page, and nothing is created before you
approve the plan. You can save the plan, or a record of a finished run, as Markdown. It works on a
phone-sized window too.

The page is served on `127.0.0.1` only and opens from the link the installer prints; every request
needs the key in that link. Pasted secrets never reach the page's history or the saved record. The
terminal mirrors the page and must stay open. See
[In your browser](installer/README.md#run-it).

---

## 2026-10-03 — Fabric: Copilot pay-as-you-go billed in Azure

The Copilot Studio and Cowork credit figures come from exports that count credits, not what was
charged. Credits beyond prepaid capacity are billed to the Azure subscription on a Power Platform
billing policy, and Azure Cost Management records that bill. The Consumption pages now show it.

`Ingest_Azure_AI` reads Copilot pay-as-you-go from the Azure AI subscription and any listed in
`PAYG_SUBSCRIPTION_IDS`, splits Copilot Studio from Cowork by the tag Azure puts on the charges, and
writes `copilot_payg_spend`. The installer reads the billing policies to find their subscriptions,
gives the app registration Cost Management Reader on each one, and adds a `CopilotPaygSpend` table
to `ValueLens Consumption Model` at deploy time. The Power BI template doesn't change. A
subscription it can't grant, or billing policies it can't read, are left out with a note, rather
than failing the run.

In the Analytics Hub, the Copilot Studio stage has a **Pay-as-you-go billed in Azure** panel: daily
cost or credits by product for the same period, with totals, the subscriptions and how the bill
compares with the export. The Cowork stage notes what Azure billed for Cowork. Billing can lag usage
by a day or more, and no currency conversion is done. Without the table, both stay hidden. See the
[data dictionary](fabric/Add%20Credit%20Consumption/DATA-DICTIONARY.md#copilot_payg_spend).

---

## 2026-10-03 — Fabric: Microsoft 365 activity and the Work patterns page

The installer has a new module, **Microsoft 365 activity**, on by default. Its notebook,
`Copilot_M365_Activity_Ingester`, reads the Microsoft 365 usage reports from Graph (Teams, Outlook,
SharePoint, OneDrive, Viva Engage and the Microsoft 365 apps) into one row per person per active
day. It uses `Reports.Read.All`, which the core already has. The installer adds it to the pipeline
behind `EnableM365Activity`, and adds an `M365 Activity` table to `ValueLens Model` at deploy time.
The Power BI templates don't change. `update` adds the module to existing installs, and the
installer's data check reports the activity table's rows and dates after each `run`.

The Analytics Hub app has a new **Work patterns** page: people active, active days, meetings and
email per week, how far each workload and app reaches, how many of the apps each person uses and on
which devices, and how Copilot users' working weeks compare with everyone else's, overall and by
organisation. The page says which days its figures cover, explains how each is worked out, and
puts organisations with fewer than five active people into one *Smaller groups* row. With the
activity loaded, Readiness's *Who to
license next* adds breadth, the Microsoft 365 workloads someone uses a day, to its priority score:
50 / 30 / 20 for tasks, days and breadth, instead of 60 / 40. People with no Microsoft 365 activity
keep the 60 / 40 score.

If the tenant conceals user names in reports, the activity can't be matched to people. The
notebook and the page say so and how to fix it, and the notebook reloads those days once the
setting is off. See the [methodology](docs/METHODOLOGY.md#84-work-patterns).

---

## 2026-10-03 — Fabric App: renamed Analytics Hub

The [Fabric App](app/) is now called **Analytics Hub**: the browser tab, the
sidebar title, the page that points visitors to Fabric, and the installer's prompts. The data side
keeps the ValueLens name: workspace, Lakehouse, models, pipeline and app registration.

The installer renames an app item still called `valuelens` or "AI in One 2.0" the next time it
runs, even if you don't rebuild the app. A name you gave it yourself is kept. A manual
`rayfin up` still creates an item called `valuelens`; rename it in the workspace.

---

## 2026-10-03 — Fabric installer: Agent Evaluator

The installer can now set up the [Agent Evaluator](fabric/Add%20Agent%20Evaluator/) from
[AgentEvaluator-for-Copilot-Studio](https://github.com/microsoft/AgentEvaluator-for-Copilot-Studio),
so the app's Agent Evaluation pages show how Copilot Studio agents perform. It's off by default.

Choose it and the installer lists the Power Platform environments you're a member of. In each one
you pick, it adds the app registration as an application user with the Bot Transcript Viewer role,
or prints the admin center steps if you aren't a System Administrator there. It deploys the
transcript parser notebook with those environments, adds it to the pipeline in merge mode so
history builds past Dataverse's 30 days, and deploys the `ValueLens Agent Evaluator Model` on the
ValueLens model's connection. The app is rebuilt with the model as its `ae` source.

The parser and template are copied from upstream commit `e37b1ac`. The notebook gains one cell that
looks up each user's UPN in Entra, so agent sessions join to org data. The installer adjusts the
template so the service can bind it to the Lakehouse connection, and so it refreshes before the
parser's first run, when it reads empty tables.

---

## 2026-10-03 — Fabric: licences that don't match people, and agent accounts

A walk-through of an older AI in One 2.0 install found three problems that our sample data
never showed.

**Hidden user names.** When the Microsoft 365 setting "Display concealed user, group, and site
names in all reports" is on, the licensed-users table holds hashed names that can't match the
audit log. The app then said 0 licensed and everyone unlicensed, with no explanation. The
`ValueLens_Data_Check` notebook now spots the hashed names and prints the admin center fix, and
the installer's data check repeats it. It also reports how many people using Copilot have a licence.

**Readiness without a matching roster.** "Who to license next" ranked every active user as if
nobody had a licence. When the roster doesn't match, Readiness now says so at the top and on the
list, and the dormancy chart explains why it is empty.

**Agent accounts counted as people.** Security Copilot agents sign in as
`SecurityCopilotAgentUser-<id>`; in that install they made 62% of audit rows and topped the
licence list. `Copilot_Audit_Log_Processor` now drops them by default
(`EXCLUDE_AGENT_IDENTITIES`, `AGENT_IDENTITY_PATTERNS`). Only the Fabric path has this so far;
Power Automate + Dataverse, SharePoint and Local CSV will follow.

---

## 2026-10-03 — Fabric App: readable consumption charts over time

The Copilot Studio "Consumption over time" and "Cost over time" charts were unreadable.
Each of about 90 daily bars carried a white value label, and the date axis showed no dates,
because every day got its own text slot only a few pixels wide. The days now sit on a real
time axis with a tick each week, the bars keep a sensible width at any panel size, and the
value labels are gone. Hover over a bar to see the day's numbers.

The Cowork / Work IQ weekly "Cost over time" chart also loses its per-bar labels, which showed
uneven decimals and a stray 0 on every week with no pay-as-you-go spend. The Azure "Foundry cost
over time" chart now has the same weekly date ticks as Copilot Studio, where before it showed only
the first of each month.

`rayfin up` could fail with "No rayfin/.temp/compiled/data/*.js files found" after the app
folder moved or `rayfin/.temp` was cleared. The data service shared the app's TypeScript build
cache, so the compiler thought it was up to date and emitted nothing. It now keeps its own cache
inside `rayfin/.temp/compiled`.

## 2026-10-03 — Paths renumbered: Fabric first

The path folders are renumbered so the recommended route comes first, and the web app now lives
inside the Fabric path:

| Was | Now |
|---|---|
| `3. Fabric` | `1. Fabric` |
| `4. Power Automate + Dataverse` | `2. Power Automate + Dataverse` |
| `2. SharePoint` | `3. SharePoint` |
| `1. Local CSV` | `4. Local CSV` |
| `5. Fabric App` | `1. Fabric/Fabric App` |

The templates, notebooks, scripts and app are unchanged apart from the paths they mention.
Links in this repo, the CI workflows, the tests and the installer all point at the new folders,
and the older entries below use the new paths so their links keep working. Bookmarks and links
from outside the repo to the old folder names will break, because GitHub doesn't redirect renamed
folders. Local CSV is still the place to start if you just want to see the dashboard. If you run
the app from a clone, `cd "1. Fabric/Fabric App"` instead of `cd "5. Fabric App"`.

## 2026-10-03 — Fabric App: small costs

On the Consumption pages, cost axes printed every tick as a whole number, so a tenant that had
spent a few cents saw a column of zeros. The axes now show as many decimals as the ticks need
(0.0001, 0.0002…) and still show whole numbers for ordinary spend. Cost cards and grid cells show a
real spend under half a cent as "<$0.01" instead of "$0.00", which read as free.

## 2026-10-03 — Consumption Central: Foundry token counts

`[Foundry Tokens (M)]` treated every Azure token meter as billed per 1M tokens. Older meters are
billed per 1K, so 212 tokens showed as 0.2 million. The measure now reads the unit from the meter
name: meters with "1M Token" are per million, other token meters are per thousand, and meters that
aren't tokens (pages, images, hours) count as zero. `[Foundry Cost per 1M Tokens]` is corrected by
the same change. Fixed in all four [Consumption Central](fabric/Add%20Credit%20Consumption/)
templates. The sample data only uses per-1M meters, so its figures don't change.

The [Fabric App](app/) now shows token counts at their own scale (212, 45K, 1.3M)
instead of in millions, where small counts rounded to 0.0.

## 2026-10-02 — Fabric installer: credit consumption

The [installer](installer/#credit-consumption) has a new optional module, *Credit
consumption*, that sets up [Consumption Central](fabric/Add%20Credit%20Consumption/) in the
same Lakehouse. It deploys the Azure AI, Copilot Studio and Cowork notebooks into the pipeline. It
gives the app registration read-only Azure roles on the subscription you choose, and makes the
upload folders. It also deploys `ValueLens Consumption Model` and adds it to the app, which turns
on the Consumption pages. Copilot Studio and Cowork have no API, so the installer prints the
steps to land their exports. `Ingest_Viva_Consumption` now skips quietly when there's no CSV, in
the installer's copy only.

## 2026-10-02 — Fabric: installer

New [`1. Fabric/installer`](installer/): run `npx valuelens-install` to set up the
Fabric path in one go. It checks the tenant and asks a few questions. It then creates the app
registration, with its secret in Azure Key Vault, and grants admin consent, or gives you a link
for an admin. It also sets up the workspace, Lakehouse, notebooks, pipeline and schedule. Last,
it runs the first load and reports what arrived. The notebooks read the secret from Key Vault
when they run.

If Azure Policy makes the vault private, the installer saves the secret through Azure Resource
Manager. It also connects the workspace to the vault with a managed private endpoint and
approves it.

Its answers and IDs are saved in `valuelens-install.json`, which holds no secrets. Re-running it
repairs what is missing. Other commands: `update`, `run`, `status`, `rotate-secret` and
`preview`. The canonical notebooks and pipeline JSON are unchanged; the installer fills in a copy
of each as it deploys.

It can also deploy the semantic model from `ValueLens - Fabric.pbit` and the ValueLens app
(`1. Fabric/Fabric App`) on top of it, so nothing has to be published from Power BI Desktop. The model
reads the Lakehouse through a cloud connection that signs in as the app registration. A new
notebook, `ValueLens_Refresh_Model`, refreshes the model as the pipeline's last step. New
commands: `refresh` and `deploy-app`.

## 2026-10-02 — Fabric App: reloads itself after a deploy

A page opened before a deploy used to fail on its next page change with *Failed to fetch
dynamically imported module*, because the deploy replaces the app's code files. The app now
reloads once to pick up the new build. If the same error comes back straight away, it stays on
screen rather than reloading again.

## 2026-10-02 — Fabric App: renamed AI in One 2.0

The [Fabric App](app/) is now called **AI in One 2.0**: the browser tab, the sidebar
title and the page that points visitors to Fabric all use the new name. The data model is still
ValueLens, and nothing else in the app changes. A new deploy still creates an item called
`valuelens`; rename it in the workspace to match.

## 2026-10-02 — Fabric App: change the task times

The [Fabric App](app/) has a new reference page, **Assumptions**. Its **Time per
task** stage lists the Conservative, Typical and Optimistic minutes behind each task's hours, with
the research link and confidence for each, and the hours each task gives at Typical.

Type over any minutes to match your organisation; the page shows the hours before you save.
**Save for everyone** stores them in the app's SQL database, in a new `TaskTime` table, and every
page in the app then values work at them. **Use research** puts a task back. Cowork hours keep their
task-category bands. The Power BI report, and the CSV, SharePoint, Fabric and Power Automate
paths, keep the model's `Human Time Estimates`.

---

## 2026-10-02 — Fabric App: the hosting address points to Fabric

Opening the [Fabric App](app/) at its `…fabricapps.net` hosting address used to offer
a sign-in, then fail every visual with *Not running inside a Fabric iframe*, because the app's
data only loads through Fabric. That address now shows an **Open in Fabric** button that goes to
the app's Fabric item, in the tenant it was deployed to.

---

## 2026-10-02 — Fabric App: cost vs value

The [Fabric App](app/)'s Value page ends with a new stage, **Cost vs value**. It sets
Microsoft 365 Copilot licences, Copilot Studio credits and Cowork / Work IQ credits against the
estimated value of the work each pays for, over the days ValueLens and Consumption Central both
hold. It shows the return on cost, with a conservative-to-optimistic range, and the break-even
hourly rate. It also shows each cost beside its value, and each Copilot Studio agent's share of
the cost beside that agent's value. Copilot Chat by people without a licence is left out of the
value, because it's free with Microsoft 365.

A **Prices** menu on the stage saves a licence price (the $30 US list price by default) and an
exchange rate, alongside the shared rates. A **Scenario** switch beside it changes the effort
scenario here and on Estimated value; it starts at Typical. Saving rates or prices now writes only the fields that
changed, so one person's save no longer overwrites another's. In the Consumption Central sample,
seven of the eight Copilot Studio agents now share names with the ValueLens sample's agents, so
the agents comparison has data. Onboarding Buddy is left unmatched on purpose. The sample's Cowork credits
now follow the ValueLens sample's Cowork pilot, with a session for each Cowork thread, so both
samples describe the same company. Cowork credits are priced as the Consumption page's Cowork
section prices them: Capacity Pack first at the prepaid rate, then pay-as-you-go. The method is in
[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md#83-cost-vs-value).

---

## 2026-10-01 — Fabric App: set-up checked from a fresh clone

A clean Windows clone of `1. Fabric/Fabric App` now passes every README step: `npm install`, build, test,
lint and a `rayfin up` dry run. Two query tests failed when Git checked the `.dax` files out with
Windows line endings, and `npm run lint` reported one error in the query hook; both are fixed. The
README now asks for Node.js 22.13 or later, the oldest 22.x release the build tools support.

---

## 2026-10-01 — methodology: from signal to task category

[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md#32-from-signal-to-task-category) has a new section
that traces each audit signal to its behaviour, its task category and its Cowork category. It lists
every rule in order, the agent keywords, the workflow split, the Cowork file-type test and the
behaviour-to-category table, with worked examples. It also notes that paths 1, 2 and 4 don't read
the agent registry or split workflows, and corrects how the doc described the value outcome and
Could have used.

---

## 2026-09-30 — a methodology document

[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) explains how ValueLens turns audit records into each
figure. It covers how records are flattened and counted, the classification rules, the value
model for Copilot, agents and Cowork, the rules behind every page, the settings you can change, and
the Fabric App's Consumption and Agent Evaluation pages. An appendix lists every time band with
its source. The root README's maturity bullet now describes the Habit Formation stages the report
actually uses.

---

## 2026-09-30 — Fabric App: a Consumption page from Consumption Central

The [Fabric App](app/) has an eighth page, **Consumption**. It reads a published
Consumption Central model, bound as a second connection (`cc`), and rebuilds that report's
consumption and cost pages. There are four sections: all products side by side, Cowork / Work IQ,
Copilot Studio and Azure. The Cowork and Studio sections each switch between a Consumption view
and a Cost view, and keep the report's period, service and group-by choices. Azure shows the
whole-solution cost export when one is loaded, and Azure AI Foundry model spend otherwise. The
Consumption Central model is optional: without it, the page says what to connect. The app also
opens in light mode by default again.

---

## 2026-09-30 — path 5: the ValueLens Fabric App (preview)

A new top-level folder, [`1. Fabric/Fabric App`](app/), holds ValueLens rebuilt as a web
app. It's hosted as an item in a Fabric workspace and queries the published ValueLens model live,
as the viewer. It runs on the model from any of paths 1–4, because all five templates carry the
fields it uses. It has seven pages: Adoption, Leaderboards, Readiness, Value, Efficiency,
Feedback and Appendix. Deploy it with `npx rayfin up`; see the folder README. The app was
developed under `1. Fabric/app` and has moved here unchanged.

---

## 2026-09-30 — task names without the "Agent:" prefix

Eleven task names started with "Agent:". Cowork and agent sessions that don't match a more
specific task are given these names, so filtering to Cowork showed a list of "Agent:" tasks.
The prefix is gone: for example, "Agent: Knowledge Base" is now **Knowledge Base**. Two names change more:
"Agent: General Purpose" is now **General Assistance**, and the "Specialist Agents" efficiency
group is now **Specialist Support**. The baselines, value outcomes and colours are unchanged.
All five templates, both processors (the Fabric notebook and the Local CSV / SharePoint /
Power Automate script), and the sample data carry the change.

- **Reprocess existing data once.** The templates look up the new names, so rows processed
  before this change have no time baseline until they're reprocessed. In Fabric, run
  `Copilot_Audit_Log_Processor` with `WRITE_MODE = "overwrite"`, which is the default. For the other
  paths, rerun `Purview_CopilotInteraction_Processor_v4.0.0.py` over your export.
- **Saved filters.** If you built your own visuals or bookmarks that filter on an old name, re-pick
  the new name.

---

## 2026-09-30 — Task Breakdown Users column blank on Cowork / Copilot

On **Task Breakdown**, the Users column in the Organization and Agent tables was bound to
`[Active Agent Users]`, which hard-codes `[Agent Filter (Normalized)] = "Agents"`. Selecting
the Cowork or Copilot button intersected that with a different segment, so every Users cell
went blank while Sessions still populated. Both tables (and the Value Outcome table's sort)
now use `[All Active Users]`, which follows the selected Licensed / Agents / Copilot / Cowork
button. Applied to all five ValueLens templates with
`scripts/Fix-TaskBreakdown-UsersMeasure.py`. Other pages that deliberately report agent users
are unchanged.

## 2026-09-29 — optional Add Credit Consumption add-on

Each path folder now has an optional `Add Credit Consumption/` folder holding
**Consumption Central**, a separate Power BI report for Copilot credit consumption and cost
across Cowork / Work IQ, Copilot Studio, GitHub Copilot and Azure AI Foundry. The ValueLens
templates are unchanged and don't read it.

- **5. Local CSV** — the Local CSV template, `pull_azure_ai.py` and the shared synthetic sample
  data.
- **4. SharePoint** — the Viva Direct template, which reads Cowork data straight from Viva
  Insights. Consumption Central has no SharePoint template.
- **1. Fabric** — the Fabric template, seven ingestion notebooks, `seed_sample_data.py` and the
  data dictionary. It can share the ValueLens Lakehouse; no table names overlap.
- **3. Power Automate + Dataverse** — the Dataverse template, flow package, schema deploy script
  and permissions. Tables use the `cc_` prefix, so they sit beside ValueLens's `poc_` tables.

Copied from `microsoft/ConsumptionCentral-for-Microsoft-Copilot` at commit `24b0ca8`, with the
fixes from microsoft/ConsumptionCentral-for-Microsoft-Copilot#39: the example addresses in the
`SecurityFilter` table now use the fictional `contoso-health.com` domain, and the Dataverse path
gets a table for Cowork / Work IQ. Links to the full documentation point at that repository.

---

## 2026-09-29 — fuller sample data

The Local CSV sample now fills every page, so a first look shows what each page does on a
real estate rather than a thin version of it. Before this, about a third of the report's
visuals came up empty or thin on the sample.

- **Bigger, longer, deeper.** 13,337 interaction rows (3,716 sessions) across three full months,
  170 people in 14 organisations with a management hierarchy, a 104-agent registry and 1,215
  feedback rows over 15 months.
- **Every page populated.** All four habit bands, dormant and never-used licences, all eight
  Cowork work shapes, Model Fit's Over-specified and Under-specified sessions, every Agent
  Registry lifecycle state, and 11 feedback types.
- **Still synthetic by construction.** `Build-SampleData.py` generates every value from a fixed
  seed. Its proportions were tuned against aggregate counts from real deployments; no rows or
  values were copied. People are invented `first.last@contoso-demo.com` names.
- **New generator options.** `--end`, `--months`, `--users` and `--unlicensed-agent-share`, and
  a coverage report after each run. `--days` is gone; use `--months`.

---

## 2026-09-29 — gentler, adjustable fit grading

Feedback on Cowork Fit was that it read as too critical (about half of graded Cowork sessions
came out Low fit) and that the rule behind it was hard to see. The grades are now plainer, the
default is less strict, and you can choose how strict it is. All five templates carry the change.

- **New labels.** High / Medium / Low fit are now **Strong fit**, **Fair fit** and **Worth a
  look**. On Model Fit, "Try cheaper" is now **Lighter model may do**; Good match and Try
  stronger are unchanged. Measure names are unchanged, so custom visuals built on them keep
  working.
- **Grading setting.** `Assumptions[Fit Grading]` is a calculated column set to `"Balanced"`. To
  change it, select the column in Power BI Desktop and edit its formula to `"Strict"` or
  `"Lenient"`.
  - **Strict** reproduces the previous grade exactly.
  - **Balanced** (default) grades two kinds of session Fair fit instead of Worth a look:
    Cowork sessions that read messages (inbox and channel work, which Cowork logs as message
    reads, previously graded as plain chat) and work done in a single app.
  - **Lenient** also grades multi-turn chats Fair fit.
- **Coaching flag.** The Cowork Fit people table has a ⚑ column. It marks anyone with at least
  five graded Cowork sessions of which half or more are Worth a look; organisation and total
  rows show how many people are flagged. It is a coaching prompt, not a ranking.
- **Clearer notices.** The "how to read" notes on Model Fit and Cowork Fit name the grading
  setting in use and say what a flag means.
- **Task categories.** Estimated Value and Task Breakdown note that their task categories are
  rule-based, so they won't match the AI-inferred categories in Copilot Analytics.
- **Glossary.** The fit rows use the new wording, and a new row explains the grading setting.

---

## 2026-09-28 — sample product feedback

- New `5. Local CSV/sample-data/product_feedback_sample.csv` (172 rows): a fabricated
  Microsoft 365 admin centre product-feedback export, so the User Feedback page fills in from
  the sample data like every other page. `Build-SampleData.py` generates it from its own
  random stream, so the other three sample files are unchanged. It uses the same 21-column
  export shape the Fabric `Copilot_ProductFeedback_Ingester` reads.
- `.gitignore`: the sample-data exception now matches `5. Local CSV/sample-data/`. It was
  anchored to a root `sample-data/` folder that doesn't exist, so new sample files were ignored.

---

## 2026-09-28 — one lean report across all five templates

The Local CSV, SharePoint, Fabric, Fabric OneLake and Power Automate + Dataverse templates had
drifted apart (different page sets and models). They now ship the same report and the same 198
measures; only the data-source layer differs. Each `.pbit`
is about 1.2 MB (previously 4.7–10.5 MB) because it no longer carries pending query edits
(`UnappliedChanges`). Setup steps are unchanged except where noted in the path READMEs.

### Report

- 15 visible pages: Activation, Adoption, Habit Formation, Agent Registry, Task Breakdown,
  Estimated Value, Model Fit, Cowork Fit, Cowork Readiness, License Readiness, User Feedback,
  Leaderboard, Trend Heatmap, and the Glossary and Signal – Impact appendices. License Allocation
  ships hidden.
- **Model Fit** (new) grades every session High, Medium or Low fit for the model it used, across
  every tool, with ranked model usage and fit by tool.
- **Cowork Fit** (new) shows what share of each Cowork task is High, Medium or Low fit, why, and
  which people drive it.
- **Cowork Readiness** ranks where to roll out Cowork next by organization, then user, the
  same way License Readiness does.
- **User Feedback** reads the optional product-feedback export, now on every template.
- Removed: the Key Concepts introduction page (the Glossary covers it) and, from the SharePoint
  template, the Credit Meter page.
- Money values share one display symbol, the `Currency Symbol Value` measure in `Assumptions`
  (default `£`). It changes the symbol only; there is no FX conversion.

### Model

- Lean pass: tables, measures, relationships and source columns that nothing reads were removed,
  and duplicate measures were folded into one survivor each.
- `Environment` is now the licensing dimension only (Licensed / Unlicensed). Cowork is flagged in
  `Agent Filter`, as the Fabric notebook already did, so a Licensed filter no longer drops licensed
  Cowork work. The Local CSV processor (`Purview_CopilotInteraction_Processor_v4.0.0.py`) and the
  sample data follow the same rule.
- `Top Value Outcome` ranks Cowork task categories when the filter context is Cowork only, so the
  Adoption page's Cowork card no longer shows the generic chat outcome.

### Agents 365: API first, CSV fallback

- **Fabric:** the pipeline runs `Copilot_Agent365_Registry_Ingester` (Graph API) and, only if it
  fails, `Copilot_Agent365_Lander` (admin-centre CSV). See the
  [pipelines README](fabric/pipelines/README.md) for the migration steps.
- **Other paths:** [`Get-Agents365Registry.ps1`](4.%20SharePoint/scripts/Get-Agents365Registry.ps1)
  writes the same 48-column registry as the Fabric notebook. `Run-PAX-AIBV.ps1
  -IncludeAgent365Info` runs it after PAX; add `-Agents365Csv` to fall back to the admin-centre
  export, or use `-Agents365Csv` alone in tenants without an Agent 365 licence.
- **Fabric templates:** `Enable_Agent365` and `Enable_ProductFeedback` default to `Include`, and a
  table that hasn't been landed yet loads empty instead of failing the refresh.

### Retired and archived

- No template reads cost consumption any more: the `copilot_cost_consumption`, `Credit Budget` and
  `Credit Unit Cost` tables and the `Cost Consumption File` parameter left the SharePoint and
  Dataverse templates.
  `Copilot_Cost_Consumption_Ingester` moved to
  `1. Fabric/archive/notebooks/`; seven shared notebooks remain.
- Power Automate + Dataverse: the `SharePoint Agents` table and the `Include SharePoint agent
  inventory` parameter were dropped (no page used them), and `Use SharePoint CSV fallback` now
  defaults to `false`. The template is built from the same project as the other four, so its old
  builder moved to `archive/scripts/`.

### Tests

- `tests/test_core_templates.py` now checks all five templates: identical report and measures,
  every report field reference resolves, neutral parameter defaults, no machine-bound parts or
  local paths, page inventory, bookmark targets and the optional Fabric tables' empty-load guard.
- The Dataverse, glossary and schema-hash tests were updated for the new templates, and CI now
  runs the full suite with no deselected tests.

### What was and wasn't validated

Every template was built from one project and passed structural, PBIR-schema and field-reference
checks. The report was refreshed in Power BI Desktop against a Fabric Lakehouse, and against
synthetic data for the Local CSV, SharePoint and Dataverse builds. The Agent 365 fallback logic
was exercised with a test harness and fixture data, not a live tenant.

This does **not** validate Power BI Service refresh, tenant Graph permissions or a production
Agent 365 run. Validate those in your own deployment before switching production over.

---

## 2026-09-15 — reviewed Fabric notebook set

These notes describe what changed in the notebooks under
[`1. Fabric/notebooks/`](fabric/notebooks/). The guidance you need in order to *run* them
is in the [Fabric README](fabric/README.md) and
`INGESTION-STRATEGY.md`.

### Audit ingester — `Copilot_Audit_Log_Direct_Ingester`

- Stable parsed-row keys now include **`Id`**, **`Source_RecordKey`**, **`Source_MessageKey`**
  and **`Source_ResourceKey`**.
- `MODE` must be **`backfill`** or **`incremental`**.
- **Backfill** writes the parsed table with **`WRITE_MODE='overwrite'`**.
- **Incremental** re-queries the trailing **`LOOKBACK_DAYS = 7`** and writes with
  **merge-by-`Id`** semantics.
- Parsed output still derives `InteractionDate`, `WeekStart` and `MonthStart` from `CreationDate`.
- Legacy parsed tables missing the stable key columns now fail clearly and require a deliberate
  fresh backfill before incremental resumes. The upgrade procedure is operational guidance and
  lives in the [Fabric README](fabric/README.md) and
  `INGESTION-STRATEGY.md`.

### Audit processor — `Copilot_Audit_Log_Processor`

- Curated output now uses **`MERGE_KEYS = ["Id"]`**.
- First curated rebuild: **`WRITE_MODE="overwrite"`**.
- Ongoing runs after the parsed-table key upgrade: **`WRITE_MODE="merge"`**.
- Merge is rejected if the source keys are missing or blank, or if the existing curated table is
  missing the merge key — rather than silently producing an ambiguous curated table.

### Snapshot-safety guards

Each snapshot source now validates before it replaces anything:

- **Licensed users:** rejects empty, malformed and conflicting duplicate rows.
- **Org data:** rejects malformed `/users` pages, conflicting duplicate identities and manager cycles.
- **Agent 365 registry:** rejects rows without `Title ID` and conflicting duplicate registry rows.
- **Product feedback:** `WRITE_MODE='append'` is explicitly rejected; missing files preserve the
  existing snapshot unless you deliberately allow an empty first placeholder.
- Feedback discovers exports using OneLake file metadata, not a notebook-local filesystem mount.
  Agent 365 aliases are projected without duplicate case-insensitive column names.

### What was and wasn't validated

The updated transformation and Delta-write paths were exercised in Fabric Spark using synthetic
inputs: audit replay/reordering, late-event insertion, processor overwrite/merge, and
licence/org/Agent 365/feedback snapshot safeguards. Local regressions also cover
extraction/checkpoint helpers and packaged model contracts.

This does **not** validate tenant Graph permissions, source retention/completeness, a production
backfill, or scheduled Power BI refresh. Validate those in your own deployment before switching
production over.

### Data check scope

`ValueLens_Data_Check.ipynb` is a **read-only diagnostic**. It shows stored flags, distinct counts
and identity overlap. It does **not** independently classify licences or prove historical parity
by itself.
