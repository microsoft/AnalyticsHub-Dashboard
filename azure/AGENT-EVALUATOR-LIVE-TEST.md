# Agent Evaluator on Azure: live test

**Don't run any of this until it's approved.** It changes a tenant and costs money: see
[What it changes](#what-it-changes). Run it on a 0.6.8 pre-release that gives the jobs' managed
identity the transcript reader role, so later than rc.2. rc.2 was the first release candidate with
Agent Evaluator on Azure, but it gave the managed identity only Bot Transcript Viewer, which reads
only the transcripts the identity owns or that are shared with it. In a test environment, that was
none.

This test runs Agent Evaluator end to end on the Azure path, against real Copilot Studio
transcripts:
- the install, and the application user and the role it adds in Dataverse;
- the jobs reading and parsing the transcripts;
- the Azure SQL tables;
- the Agent Evaluator model;
- the app's pages.

It also times the run, and checks that Repair or change, `status` and `uninstall` add and remove
what they should. `tests/test_azure_agent_evaluator.py` covers the collector against a fake
Dataverse, and the installer's tests cover its Dataverse calls against a fake client. This covers
what those tests can't.

The commands are PowerShell. The steps use public endpoints. With private networking, the logs
are in `ContainerAppConsoleLogs` (columns `ContainerGroupName` and `Log`), not
`ContainerAppConsoleLogs_CL`.

## What it changes

| | |
|---|---|
| **Dataverse** | The jobs' managed identity becomes an application user with two roles in one or two environments: **Bot Transcript Viewer**, and a role the installer creates for the install, *Analytics Hub transcript reader* and the first 8 characters of the install's ID, which holds only ConversationTranscript read at Organization depth. The installer adds the user and both roles in A. In B you add the user and a role of your own by hand (step 7), and the installer then adds its role there too. Steps 9 to 11 and uninstall remove what the installer added, or print the steps. You remove B's user and your role yourself (step 14). |
| **Data read** | Up to 180 days of Copilot Studio transcripts from those environments. The jobs keep only parsed rows: prompts, replies and error messages as 500-character previews; feedback comments as written, up to 4,000 characters; and each person's Entra object ID and UPN. They're kept in the test install's storage account and Azure SQL database, and are deleted with its resource group. |
| **Spend** | One Azure install in a new resource group that holds nothing else. If you build the images (step 0), also an Azure Container Registry in its own resource group. Both are deleted the same day. See [What it costs](../docs/PREREQUISITES.md#what-it-costs). |
| **Power BI** | A new workspace with the install's models. Uninstall asks whether to delete it, and you say yes (step 13). |
| **Teams** (optional) | Publishing the Teams app to the org catalog, to check the pages in Teams, Outlook and the Microsoft 365 app. It's a Teams change, so it needs separate approval. |
| **Graph** | No new permission. The UPN lookup uses `User.Read.All`, which the identity already has for the core data. |

## What you need

- A test tenant that's approved for this, and a subscription where you can create resource groups.
- Environment **A**, and optionally **B**: Power Platform environments with Copilot Studio agents
  that people have chatted with in the last 30 days. B tests the manual path and a second
  environment. Developer and Dataverse for Teams environments won't work: Copilot Studio doesn't
  save their transcripts.
- Transcripts saved in each environment. In the [Power Platform admin
  center](https://admin.powerplatform.microsoft.com), go to **Manage** > **Environments** > the
  environment > **Settings** > **Product** > **Features**. Under **Copilot Studio agents**, turn on
  **Allow conversation transcripts and their associated metadata to be saved in Dataverse**. An
  environment group's rules can override this setting. Dataverse keeps transcripts for 30 days by
  default.
- An account that:
  - is a user and a **System Administrator** in each environment. The installer lists only the
    environments you're a user in.
  - has what the [Azure target](../installer/README.md#azure-target) needs:
    - Contributor and User Access Administrator, or Owner;
    - permission to register Entra apps;
    - a Global Administrator or Privileged Role Administrator, for the identity's Graph roles;
    - Power BI Pro or PPU;
    - the two tenant settings.
- Node.js 22.13 or later, Git, and the Azure CLI signed in to the test tenant (`az login`).

## 0. The code, the images and the install record

Clone the branch under test into a new folder, and keep the install record outside the clone:

```powershell
git clone --branch <pre-release tag or branch under test> https://github.com/microsoft/AnalyticsHub-Dashboard "$HOME\ae-live-test\src"
$rec = "$HOME\ae-live-test\valuelens-install.json"
```

If the branch under test doesn't include
[#144](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/144), don't load a Workday
org-data export that has a `Department` column on this install. Without #144, the models rename
`Department` to `Organization` even though the org data already has `Organization`, so the refresh
fails. On Azure, publish never drops a column, so the core and Agent Evaluator refreshes would both
keep failing. To check, look for the test #144 adds. No output means #144 isn't in the branch:

```powershell
Select-String -Path "$HOME\ae-live-test\src\installer\test\model.test.js" -SimpleMatch 'not Table.HasColumns(RenamedPersonId, "Organization")'
```

The jobs and web images have to contain the code under test. The installer deploys
`<registry>/valuelens-jobs:<tag>` and `<registry>/valuelens-web:<tag>`. Unless the install record
pins others, the registry is `ghcr.io/microsoft` and the tag is the version in
`installer/package.json` (see [Regions and images](../installer/README.md#regions-and-images)).
The released images don't have Agent Evaluator on Azure, so always pin a tag that does. Do one of
these:

- **Release candidate images**, once the pre-release's are published:

  ```powershell
  [IO.File]::WriteAllText($rec, '{"version":1,"target":"azure","azure":{"images":{"tag":"<pre-release tag>"}}}')
  ```

- **Your own build**, in a new registry in its own resource group.
  - Build before you install the installer's dependencies below. There's no root
    `.dockerignore`, so `az acr build` uploads everything in the clone, `node_modules` folders
    included.
  - The package locks can point at an internal npm mirror that build agents can't reach. Switch
    them to the public registry for the build, then put them back.

  ```powershell
  cd "$HOME\ae-live-test\src"
  az group create -n <registry resource group> -l <region>
  az acr create -g <registry resource group> -n <registry> --sku Basic
  node installer/packaging/public-registry.js app/package-lock.json azure/web/package-lock.json
  az acr build -r <registry> -t valuelens/valuelens-jobs:ae-test -f azure/jobs/Dockerfile .
  az acr build -r <registry> -t valuelens/valuelens-web:ae-test -f azure/web/Dockerfile .
  git checkout -- app/package-lock.json azure/web/package-lock.json
  $acr = az acr show -n <registry> --query id -o tsv
  [IO.File]::WriteAllText($rec, (@{ version = 1; target = 'azure'; azure = @{ images = @{
    registry = '<registry>.azurecr.io/valuelens'; registryResourceId = $acr; tag = 'ae-test' } } } | ConvertTo-Json -Depth 5))
  ```

  With `registryResourceId` set, the installer gives the jobs' identity AcrPull on the registry.

The installer can't read a record that starts with a byte order mark. Windows PowerShell's
`Set-Content -Encoding utf8` adds one, so write the record with `[IO.File]::WriteAllText`, which
doesn't.

Then install the installer's dependencies in the clone:

```powershell
cd "$HOME\ae-live-test\src\installer"
npm install
```

Run every installer command below from the clone's `installer` folder, with `--config $rec`. Run
`node azure/tools/...` from the clone's root. To read what the record holds at any point:

```powershell
$cfg = Get-Content $rec -Raw | ConvertFrom-Json
```

## 1. Check the environments have transcripts

Set each environment's URL: in the admin center, it's the environment's **Environment URL**. Then
define a helper that reads the Dataverse Web API as you:

```powershell
$A = 'https://<environment A>.crm.dynamics.com'
$B = 'https://<environment B>.crm.dynamics.com'
function Get-Dv([string]$EnvUrl, [string]$Path) {
  $t = az account get-access-token --resource $EnvUrl --query accessToken -o tsv
  $h = @{ Authorization = "Bearer $t"; Accept = 'application/json'; Prefer = 'odata.maxpagesize=5000' }
  $u = "$EnvUrl/api/data/v9.2/$Path"
  while ($u) { $p = Invoke-RestMethod -Headers $h -Uri $u; $p.value; $u = $p.'@odata.nextLink' }
}
Get-Dv $A 'conversationtranscripts?$select=createdon,conversationstarttime&$orderby=createdon desc&$top=5'
$since = (Get-Date).ToUniversalTime().AddDays(-180).ToString('yyyy-MM-ddTHH:mm:ssZ')
@(Get-Dv $A ('conversationtranscripts?$select=conversationtranscriptid&$filter=conversationstarttime ge {0}' -f $since)).Count
```

Do the same for B, and note the counts. If an environment has no transcripts, chat with one of its
agents in Copilot Studio's test pane (not in a developer environment), then wait. Dataverse writes a
transcript when a conversation ends, or after it's been idle for about 30 minutes.

## 2. Install

```powershell
npx valuelens-install install --target azure --config $rec
```

- Choose **Create a new resource group**, so that uninstall deletes it. If you change the advanced
  settings, keep **Public endpoints** and **Your tenant's data**.
- At **Tick the data you want**, tick **Agent Evaluator**. Leave the other optional sources off,
  so the run is mostly Agent Evaluator.
- At **Read the environments that hold your Copilot Studio agents**, leave only **A** ticked. The
  list holds the environments you're a user in, and the first time, the installer ticks those
  with agents.
- When the plan asks whether to publish the Teams app, say no unless the Teams part was approved.

The plan should list a **Dataverse application user**, **Jobs' managed identity in A**, and a
**Dataverse security role**, **Analytics Hub transcript reader** followed by the first 8
characters of the install's ID, **in A**. Below, `<ID>` is those 8 characters. The
**Transcript access** step should then say:
- `Created the "Analytics Hub transcript reader <ID>" role in A: it reads every Copilot Studio conversation transcript there, and nothing else`;
- `Gave the jobs' managed identity the Bot Transcript Viewer and "Analytics Hub transcript reader <ID>" roles in A`;
- `Checked one transcript in A: the jobs' managed identity can read it`. If it says instead that
  Dataverse shows it can't read one yet, note that: role changes can take a few minutes.

The installer then starts the first run without waiting for it.

Check the user and the role in Dataverse. The identity's name starts with
`id-<prefix>-collector-`, and the default prefix is `vlens`.

```powershell
$rg = '<resource group>'
$mi = az identity list -g $rg --query "[?contains(name,'-collector-')].clientId | [0]" -o tsv
$u = Get-Dv $A ('systemusers?$select=systemuserid,fullname,isdisabled&$filter=applicationid eq {0}' -f $mi)
$u
Get-Dv $A ('systemusers({0})/systemuserroles_association?$select=name' -f $u.systemuserid)
$ta = (Get-Content $rec -Raw | ConvertFrom-Json).azure.transcriptAccess
$ta
$ra = $ta | Where-Object { $_.url -like "$A*" }
$t = az account get-access-token --resource $A --query accessToken -o tsv
(Invoke-RestMethod -Headers @{ Authorization = "Bearer $t"; Accept = 'application/json' } -Uri ("$A/api/data/v9.2/RetrieveRolePrivilegesRole(RoleId=@r)?@r={0}" -f $ra.readRoleId)).RolePrivileges | Select-Object PrivilegeName, Depth
```

- One user, with `isdisabled` set to False, and Bot Transcript Viewer and
  `Analytics Hub transcript reader <ID>` among its roles.
- The role holds exactly one privilege: `prvReadconversationtranscript` at `Global` depth, which
  the admin center calls Organization. It holds none of the platform privileges a new role comes
  with.
- In the admin center, A's **Settings** > **Users + permissions** > **Application users** lists
  the user. Note the name it shows there, for the docs. **Security roles** lists the role.
- The record has one entry, for A: its `appId` is `$mi`, and it has a `userId`, a `roleId`,
  `createdUser` set to True, the role's `readRoleId` and `readRoleName`, `createdReadRole` set to
  True, and an `assignedReadRoleId`. That's what tells uninstall to delete the user and the role.

## 3. The first run

Find the run job's executions, and wait for the latest to show `Succeeded`:

```powershell
$job = az containerapp job list -g $rg --query "[?ends_with(name,'-run')].name | [0]" -o tsv
az containerapp job execution list -g $rg -n $job --query "[].{name:name,status:properties.status,start:properties.startTime,end:properties.endTime}" -o table
```

While it runs, you can watch it with
`az containerapp job logs show -g $rg -n $job --execution <execution name> --container run`.

For the whole log with timestamps, read Log Analytics. Lines arrive there a few minutes after
they're written, and the Azure CLI may ask to add its `log-analytics` extension.

```powershell
$exe = '<execution name>'
$law = az monitor log-analytics workspace list -g $rg --query "[0].customerId" -o tsv
az monitor log-analytics query -w $law --analytics-query "ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith '$exe' | order by _timestamp_d asc | project TimeGenerated, Log_s" --query "[].[TimeGenerated, Log_s]" -o tsv > run1.txt
```

Expect these lines, in this order:

1. `<A's URL>: first complete read, so going back 180 days`.
2. `Agent Evaluator: 1 environment(s), 4 read window(s), up to 4 at a time`.
3. `<A's URL> [<start> .. <end>]: +N`, one line per window as it finishes. The last window ends at
   `now`. There's no `window failed` line.
4. `parsed N transcript(s): V with JSON content, C without a transcript ID, F couldn't be parsed`.
   Note any `couldn't parse` lines.
5. `resolved X of Y user object IDs to UPNs`. X can be lower than Y for people who have left, or
   who aren't in the directory.
6. `ok        <A>: N transcripts in the last 180 days`.
7. The `publish agent_…` lines:
   - `agent_sessions`, `agent_turns`, `agent_errors`, `agent_subagents` and `agent_performance`
     say `D day(s) rewritten (R rows), 0 removed, 0 unchanged`;
   - `agent_catalogue` and `evaluator_status` say `replaced with N row(s)`.
8. `refresh: ae`, then `refresh: started …`, and later `step refresh: done`. The Agent Evaluator
   model refreshes after the others.

Check:

- **Transcripts found.** A's status line says `ok`, not `empty` (`0 transcripts found in …`).
  `empty`, when step 1 counted transcripts, means the managed identity can't read them: check its
  roles as in step 2.
- **Counts.**
  - The `+N` values add up to N on the status line.
  - That's also the Dataverse count from the earliest window's start: run step 1's count with
    `$since` set to that start. Dataverse can be a little higher if transcripts arrived after the
    run read them.
- **Transcripts built.** V − C − F is the number of transcripts that became sessions. It should
  equal R on the `publish agent_sessions` line.
- **Throttling.** Count the lines that say `returned 429; retrying in`. A few are fine: the jobs
  wait as long as `Retry-After` says and carry on.
- **Bot lookup.** Note whether `no bot lookup on conversationtranscripts` appears. If it does,
  check that the app still names each agent.

## 4. The model, the pages and `status`

```powershell
npx valuelens-install status --config $rec
```

Among its lines:

- `Evaluator:      <model ID>`;
- `Agents:         1 of 1 environment(s) readable`, then `✓ <A> (<A's host>)`;
- `Last read:      <time>`, then `<A>: ok (N transcripts in the last 180 days)`, from the model's
  **Evaluator Status** table.

Then check the model and its refresh schedule. The record holds both IDs:

```powershell
$cfg = Get-Content $rec -Raw | ConvertFrom-Json
$ws = $cfg.azure.powerBi.workspaceId; $ds = $cfg.azure.powerBi.agentEvaluatorDatasetId
function Get-Schedule { az rest --method get --url "https://api.powerbi.com/v1.0/myorg/groups/$ws/datasets/$ds/refreshSchedule" --resource https://analysis.windows.net/powerbi/api --query enabled -o tsv }
Get-Schedule
```

- **Schedule.** `Get-Schedule` says `true`: the model has a scheduled refresh, as the other
  models do.
- **Refresh.** In Power BI, the Agent Evaluator model's refresh history shows the run's refresh as
  Completed.
- **Row counts.** Count the tables through the model:

  ```powershell
  Set-Content -Encoding ascii dax.json '{"queries":[{"query":"EVALUATE ROW(\"Sessions\", COUNTROWS(''Agent Sessions''), \"Turns\", COUNTROWS(''Agent Turns''), \"Errors\", COUNTROWS(''Agent Errors''), \"Performance\", COUNTROWS(''Agent Performance''), \"Longest preview\", MAXX(''Agent Turns'', LEN(''Agent Turns''[text_preview_500])), \"Longest feedback\", MAXX(''Agent Turns'', LEN(''Agent Turns''[feedback_comment])))"}]}'
  az rest --method post --url "https://api.powerbi.com/v1.0/myorg/groups/$ws/datasets/$ds/executeQueries" --resource https://analysis.windows.net/powerbi/api --body '@dax.json'
  ```

  - Sessions, Turns, Errors and Performance equal R on the `publish` lines for `agent_sessions`,
    `agent_turns`, `agent_errors` and `agent_performance`.
  - The longest preview is 500 characters or fewer, and the longest feedback 4,000 or fewer.
- **The app's queries.** Run every query on the Agent Evaluation pages against the model, from
  the clone's root. Comparing the model with itself shows which queries fail.

  ```powershell
  node azure/tools/parity.mjs --a "$ws/$ds" --b "$ws/$ds" --only agent-evaluation/ --out parity-ae.json
  node azure/tools/parity.mjs --a "$ws/$ds" --b "$ws/$ds" --only freshness/evaluator --out parity-ae-freshness.json
  ```

  - Every query should be `match`, or `both-empty` where there's no data for it. None should be
    `both-error`.
  - The script exits 0 whatever it finds, so read the summary.
  - It signs in with `az login`, or uses `POWERBI_TOKEN` if that's set.
- **Pages.** Open the web app as a viewer, and go to **Agent Evaluation**. Check:
  - **Performance** and **Conversations & topics** load, with no error on any visual.
  - The **Date** presets, the **Department** and **Agent** slicers, and **Group by** on Performance
    each change the visuals without an error.
  - Wherever a page shows a total, it matches the DAX counts for the same dates.
  - The freshness line says **Agent evaluation to** the date of the latest transcript.
  - If the Teams app was published, all of the above in Teams, Outlook and the Microsoft 365 app
    too.
- **Org-scoped access** (optional). Turn it on with `access`. A viewer who's given one org should
  see only that org's sessions on these pages.

## 5. The next run

```powershell
npx valuelens-install run --config $rec
```

When it finishes, read its log as in step 3, and check:
- there's no `first complete read` line;
- A's windows start about 14 days back: the days since its last complete read plus one, and at
  least 14;
- the status line counts the transcripts in those days;
- the five day-by-day `publish agent_…` lines show most days `unchanged`. Only days with new or
  changed transcripts are rewritten.

## 6. Paging

Make Dataverse return 5 transcripts a page:

```powershell
az containerapp job update -g $rg -n $job --set-env-vars VALUELENS_TRANSCRIPT_PAGE_SIZE=5
npx valuelens-install run --config $rec
```

When the run finishes, read its log and put the page size back:

```powershell
az containerapp job update -g $rg -n $job --remove-env-vars VALUELENS_TRANSCRIPT_PAGE_SIZE
```

- This only tests paging if a window holds more than 5 transcripts, so check that at least one
  `+N` is above 5.
- Expect step 5's counts, plus any transcripts that have arrived since then.
- Note any `returned 429` lines: this run makes many more requests.
- If you forget to put the page size back, the next Repair or change resets it.

## 7. A second environment, added by hand

This checks the manual steps the installer prints. In the admin center, open environment B, then
**Settings** > **Users + permissions**.

1. **Security roles** > **+ New role**. Name it *Analytics Hub transcript reader*, keep the root
   business unit, turn off **Include App Opener privileges for running Model-Driven apps**, and
   **Save**. Then set the **ConversationTranscript** table's **Read** to **Organization**, and
   **Save**. Note anything the admin center names differently, so the docs can be fixed.
2. **Application users** > **+ New app user** > **+ Add an app**.
3. Search for the identity's client ID (`$mi`), not its name. Microsoft's docs say this search
   accepts a managed identity's client ID; note whether it found it.
4. Pick the identity, choose the root business unit, add the **Bot Transcript Viewer** security
   role and the new role, and select **Create**.

If the search doesn't find the identity, cancel, and note it so the docs' manual steps can be
fixed. The installer then adds the user in B in the next step, with both roles, as it did in A,
and uninstall removes them.

Check that the role you made lets the identity read B's transcripts. As a System Administrator,
ask Dataverse about one transcript:

```powershell
$ub = Get-Dv $B ('systemusers?$select=systemuserid&$filter=applicationid eq {0}' -f $mi)
$tx = Get-Dv $B 'conversationtranscripts?$select=conversationtranscriptid&$top=1'
$target = [uri]::EscapeDataString(('{{"@odata.id":"conversationtranscripts({0})"}}' -f $tx.conversationtranscriptid))
$t = az account get-access-token --resource $B --query accessToken -o tsv
Invoke-RestMethod -Headers @{ Authorization = "Bearer $t"; Accept = 'application/json' } -Uri ("$B/api/data/v9.2/systemusers({0})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t={1}" -f $ub.systemuserid, $target)
```

`AccessRights` should include `ReadAccess`. With Bot Transcript Viewer alone, it's usually `None`.

Then add B through Repair or change:

```powershell
npx valuelens-install update --config $rec
```

Choose **Repair or change**, open **Module connections**, and tick B as well as A. Expect:
- It finds the user you made and doesn't add another: check with `Get-Dv $B` as in step 2, and
  there's one user.
- You're a System Administrator of B, so it also creates its own role there, and gives it:
  `Created the "Analytics Hub transcript reader <ID>" role in B: …`, then
  `Gave the jobs' managed identity the "Analytics Hub transcript reader <ID>" role in B`. It
  doesn't change the role you made.
- B's entry in the record has a `userId`, a `readRoleId` with `createdReadRole` set to True, and
  an `assignedReadRoleId`, but no `roleId` and no `createdUser`. So uninstall deletes the
  installer's role in B, and leaves B's user, its Bot Transcript Viewer role and the role you made.
- On the next run, B gets a first read of 180 days and A its usual 14 days. Use `run` if `update`
  doesn't start one. Both status lines say `ok`.
- `status` says `Agents:         2 of 2 environment(s) readable`.

Optional, the error paths:
1. In B, take the two transcript reader roles off the identity's user, the installer's and yours,
   and leave Bot Transcript Viewer (edit the user's security roles). `run`, and check that B's
   status line says `empty` (`0 transcripts found in …`), as on rc.2, unless some of B's
   transcripts are shared with the identity.
2. Take Bot Transcript Viewer off too. `run`, and check that:
   - B's status line says `forbidden`, and the reason names the Bot Transcript Viewer role and the
     installer's transcript reader role;
   - A is still read.
3. Give the three roles back.

Optional, an environment you can't add the identity to. This needs an environment C where your
account is a user but not a System Administrator.
1. In `update`, tick C as well. The list says an admin adds the jobs' managed identity there.
2. The installer can't add it, so it prints the steps for an admin: creating the role, then adding
   the identity, by its client ID, with both roles. It asks what to do. Choose
   **Leave it out for now**.
3. Check that:
   - `status` says `2 of 3 environment(s) readable`, with `!` beside C;
   - the next run's status line for C says `forbidden`, and A and B are read;
   - the scheduled refresh stays on: `Get-Schedule` says `true`.
4. Untick C again.

## 8. Speed

From the timestamps in the logs of the first run (step 3) and the run that first read B (step 7):

| Part | From | To |
|---|---|---|
| Read | `Agent Evaluator: … read window(s)` | the last `+N` line |
| Parse tail | the last `+N` line | `parsed N transcript(s)` |
| Merge and UPNs | `parsed N transcript(s)` | the last status line |
| Publish | the first `publish agent_` line | `publish evaluator_status` |
| Model refresh | `refresh: ae` | `step refresh: done` |
| Whole run | the execution's start | its end, from `az containerapp job execution list` |

Also note:
- the number of transcripts read (the `+N` values added up) and turns published;
- the number of `returned 429` lines;
- whether the run ran out of memory:

```powershell
az monitor log-analytics query -w $law --analytics-query "ContainerAppSystemLogs_CL | where TimeGenerated > ago(1d) | search 'OOMKilled'" -o table
```

For comparison, these figures were measured offline on a laptop (#133):
- reading and parsing 20,000 transcripts took 18.5 s, and 100,000 about 101–108 s;
- the next day's run, with 20,000 in history, took 3.9 s;
- the merge peaked at 1.74–1.89 GiB with 100,000.

A test environment holds far fewer transcripts, so this mostly shows that nothing is unexpectedly
slow. Look for long gaps between `+N` lines, many 429s, or OOMKilled. The run job has 4 vCPU and
8 GiB, and 4 hours a run.

## 9. Remove environment A

Run `update`, choose **Repair or change**, open **Module connections**, and untick A. Expect:
- The plan's row for **Jobs' managed identity in A** says the installer deletes the application
  user it created. Its row for the **Analytics Hub transcript reader <ID>** role in A says it takes
  the role away and deletes the role it created.
- `Deleted the "Analytics Hub transcript reader <ID>" role in A`. Looking the role up by name finds
  nothing: `Get-Dv $A ('roles?$select=roleid&$filter=name eq ''{0}''' -f $ra.readRoleName)`.
- Then one of these. Note which: it shows whether Dataverse's Web API deletes an application user,
  and whether a second delete removes one the first only soft-deleted.
  - `Removed the application user for the jobs' managed identity <name> (client ID <$mi>) from A`.
    The installer read the user back after deleting it, deleting it again if it was still there,
    and found it gone. `Get-Dv $A` as in step 2 finds no user.
  - `Dataverse only soft-deleted the application user …`, saying it's deactivated with no role,
    then how a System Administrator deletes it for good. `Get-Dv $A` as in step 2 finds it with
    `isdisabled` True, and with neither role.
    `Get-Dv $A ('systemusers?$select=isdisabled,deletedstate&$filter=applicationid eq {0}' -f $mi)`
    shows `deletedstate` 1. Follow the printed steps, and note whether the admin center's filter
    lists the user and deletes it.
  - `Dataverse wouldn't delete the application user …`, saying it has no role now, then the steps
    for a System Administrator. The installer turned the user back on, so `Get-Dv $A` finds it
    with `isdisabled` False and with neither role.
- The record has no entry for A.
- The next run reads B only. A's sessions stay in the app until uninstall.

Then tick A again. Expect
`Created the "Analytics Hub transcript reader <ID>" role in A: …`, then
`Gave the jobs' managed identity the Bot Transcript Viewer and "Analytics Hub transcript reader <ID>" roles in A`,
and another 180-day first read of A on the next run. The role has the same name as before and a
new ID. If Dataverse wouldn't delete the user, the installer finds it and only gives it the roles:
A's entry has a `roleId` and the read role's fields but no `createdUser`, so uninstall deletes the
installer's role, takes Bot Transcript Viewer away, and leaves the user for step 14. If it only
soft-deleted the user, and it's still there, the installer finds it disabled:
`The jobs' managed identity's application user in A is disabled, so its transcripts are skipped.`
Delete it for good as printed, then tick A again.

## 10. No environment to read

Run `update`, choose **Repair or change**, open **Module connections**, and untick A and B. Leave
**Agent Evaluator** ticked. Expect:
- `No environments chosen, so the jobs don't read transcripts.`
- A's role deleted and its user removed, as in step 9.
- For B: `Deleted the "Analytics Hub transcript reader <ID>" role in B`, then
  `The jobs' managed identity … is still an application user in B. It was added outside the
  installer, so the installer leaves it`, and the steps for a System Administrator. `Get-Dv $B`
  still finds the user, with Bot Transcript Viewer and the role you made in step 7.
- The record has no `transcriptAccess` entries.
- `status` still shows `Evaluator:      <model ID>`, then `Agents:         no environments chosen`.
- The Agent Evaluation pages still show the sessions already read.
- `Get-Schedule` says `false`: nothing new can load, so the model's scheduled refresh is off.
- The next run has no `Agent Evaluator:` line. It says
  `collect agent_evaluator: VALUELENS_DATAVERSE_ENVIRONMENTS lists no environment yet; skipped` and
  `refresh: ae skipped; VALUELENS_DATAVERSE_ENVIRONMENTS lists no environment yet, so nothing loads into it`.
  Its `publish agent_…` lines publish what was already read again, with no day rewritten.

Then tick A and B again. Expect A's roles as in step 9. In B, the installer finds the user and
doesn't add another, and creates its role again and gives it, as in step 7. Then `Get-Schedule`
says `true`, and the next run reads both and ends with `refresh: ae`.

## 11. Untick and tick Agent Evaluator

Run `update`, choose **Repair or change**, open **Data collection**, and untick
**Agent Evaluator**. Expect:
- A's role deleted and its user removed as in step 9, and B's role deleted and its user left as in
  step 10.
- The Agent Evaluation pages are gone from the web app, once its new revision is running.
- `status` has no `Evaluator:` or `Agents:` lines.
- The model is still in the workspace, and the record keeps its ID:
  `(Get-Content $rec -Raw | ConvertFrom-Json).azure.powerBi.agentEvaluatorDatasetId` is `$ds`.
- `Get-Schedule` says `false`.
- The next run has no `Agent Evaluator:` lines and no `refresh: ae` line.

Then tick **Agent Evaluator** again. **Module connections** still has A and B ticked. Expect:
- `status` shows the same `Evaluator:` ID, and the workspace still has one Agent Evaluator model.
- A's roles as in step 9. In B, the installer creates its role again and gives it, as in step 7:
  unticking the module deleted it, and kept B's user with its other roles.
- The pages are back, `Get-Schedule` says `true`, and the next run reads both and ends with
  `refresh: ae`.

## 12. Demo mode (optional)

Demo mode changes the whole install, not only Agent Evaluator, so this step is optional. Run
`update`, choose **Repair or change**, open **Data collection**, and choose
**Demo mode (sample data)**. Expect:
- No Dataverse rows in the plan, and the note `Demo mode reads no transcripts. The jobs' managed
  identity … keeps its access in 2 environments for when you switch to your tenant's data.`
- `Get-Dv $A` and `Get-Dv $B` find both users as they were, each with its roles, and the
  installer's role is still in both environments.
- The Agent Evaluation pages are gone, `status` has no `Evaluator:` or `Agents:` lines, and
  `Get-Schedule` says `false`.

Then switch back to **Your tenant's data**. Expect
`The jobs' managed identity can read every transcript in A`, the same for B, no change in
Dataverse, and the pages, the `status` lines and the schedule back, with the same model ID.

## 13. Uninstall

```powershell
npx valuelens-install uninstall --config $rec
```

Expect:
- first, a question whether to delete the Power BI workspace it created. Say yes;
- then, before any deletes, A's role deleted and its user removed as in step 9, and B's role
  deleted and its user left with the note as in step 10;
- it deletes the workspace with its models, the resource group, and the app registrations it
  created.

Check A and B with `Get-Dv` and in the admin center. Neither has an
*Analytics Hub transcript reader <ID>* role.

## 14. Clean up

- B's user: in the admin center, select it under **Application users**, **Deactivate** it, then
  **Delete** it. Only a deactivated application user can be deleted.
- The role you made in B: under **Security roles**, select it, then **Delete**.
- A's user, the same way, if Dataverse wouldn't delete it in step 9 or 13. If it only
  soft-deleted it, use the steps the installer printed: **Users** > **Filter** >
  *Users not in Microsoft Entra ID and soft deleted in the environment* > the user > **Delete**.
- Any *Analytics Hub transcript reader <ID>* role the installer couldn't delete, as for the role you
  made.
- The Power BI workspace, if uninstall couldn't delete it in step 13.
- The registry's resource group, if you built the images:
  `az group delete -n <registry resource group> --yes`.
- The Teams app, if a Teams admin uploaded it and it's still in the Teams admin center.
- `$HOME\ae-live-test`.
- The transcript setting, if you turned it on for this test.

## 15. Results

| Step | Check | Result |
|---|---|---|
| 1 | Transcripts in A and B in the last 180 days | |
| 2 | The installer added A's application user with Bot Transcript Viewer and its transcript reader role, and recorded that it created both; the role holds exactly `prvReadconversationtranscript` at `Global`; the one-transcript check; the name the admin center shows | |
| 3 | A's status `ok`, not `empty`; the `+N` total = the status count = the Dataverse count | |
| 3 | V − C − F = `agent_sessions` rows; parse failures; 429 lines; bot lookup | |
| 4 | The `status` lines; schedule on; refresh Completed; DAX counts = published rows; preview ≤ 500 and feedback ≤ 4,000 characters | |
| 4 | `parity.mjs`: every query `match` or `both-empty` | |
| 4 | Pages, slicers and the freshness line, in a browser (and in Teams, Outlook and Microsoft 365) | |
| 5 | 14-day windows; most days unchanged | |
| 6 | Paging: the same counts at 5 a page | |
| 7 | The role made by hand, and what the admin center put in it; the admin center found the identity by client ID; `ReadAccess` on a transcript; no second user; the installer's role created and given in B, and B's user recorded as not created by the installer; B's first read | |
| 7 | Optional: B `empty` with only Bot Transcript Viewer, `forbidden` with no role; C left out, `forbidden`, schedule still on | |
| 8 | Read, parse tail, merge, publish, refresh and whole-run times; 429s; no OOMKilled | |
| 9 | A's role deleted; whether the Web API deleted A's user, only soft-deleted it, or wouldn't delete it and the installer turned it back on without its roles; A's rows kept; A added again, with the role created again | |
| 10 | No environment: pages kept; schedule off; `refresh: ae skipped`; the installer's role deleted in B and B's user left; both back | |
| 11 | Module off: pages gone, schedule off, model and ID kept, the installer's roles deleted; back on: the same ID, the roles created again, schedule on | |
| 12 | Optional demo mode: no Dataverse change; pages and schedule off, then back | |
| 13 | Both installer roles deleted; A's user removed, or the steps printed; B's user left; the workspace and the resource group gone | |
| 14 | Clean-up done | |

## Optional: compare with Fabric

This needs a Fabric install whose Agent Evaluator reads the same environment at about the same
time. Compare its model with the Azure one:
`node azure/tools/parity.mjs --a <Fabric workspace ID>/<model ID> --b "$ws/$ds" --only agent-evaluation/ --out parity-ae-fabric.json`.

It needs a Fabric capacity, so it costs more and needs separate approval. Row counts can differ by
the transcripts that arrive between the two reads.
