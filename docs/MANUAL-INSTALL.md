# Manual install

Set Analytics Hub up by hand, step by step, without the installer. It uses the same files the
installer does. Use it only if no [install route](INSTALL.md) works for you, or you want to see
each piece.

- **Fabric or Azure.** Fabric is sections 1 to 3. Azure is [one section](#azure), in Azure Cloud
  Shell.
- **It takes longer**, and you update it by hand. The [installer](INSTALL.md) is quicker and
  does more for you: see [What you don't get by hand](#what-you-dont-get-by-hand).
- **Watch first** (Fabric): the [manual setup video](../fabric/README.md#set-it-up-by-hand), from
  a fresh app registration to a self-refreshing report.

## 1. Prerequisites

Everything in [Prerequisites](PREREQUISITES.md) for Fabric, plus:

| You need | Why |
|---|---|
| An Entra **app registration** you create, with the Graph permissions in [Permissions](PERMISSIONS.md#core-sources-required), admin consent and a client secret | The notebooks sign in as it. The installer creates it for you |
| Somewhere for the secret: an Azure **Key Vault** (with *Key Vault Secrets User* for whoever runs the notebooks), or the notebooks themselves | Key Vault keeps it from workspace viewers. See [Where the client secret goes](../fabric/README.md#where-the-client-secret-goes) |
| A Fabric workspace with a **Lakehouse**, with **Lakehouse schemas** on | Where the data lands |
| **Power BI Desktop**, June 2024 or later | To open the report template and publish it. Earlier releases show errors in most habit-stage visuals |
| [Node.js](https://nodejs.org/) 24.15 or later, or 22.22 or later | Only to deploy the app |

The Fabric admin's tenant settings are in
[Prerequisites](PREREQUISITES.md#fabric-admin-about-5-minutes).

## 2. Install

Do these in order. Each link has the steps.

1. **[Load the data](../fabric/notebooks/README.md).** Import the 4 core notebooks, attach the
   Lakehouse, fill in the first cell, run the ingesters, then the processor.
2. **[Publish the report](../fabric/notebooks/README.md#load-the-data)** (step 6). Open
   `ValueLens - Fabric.pbit` in Power BI Desktop and publish it. This also gives you the
   semantic model the app reads.
3. **[Schedule it](../fabric/pipelines/README.md).** Paste the pipeline, fill in the IDs, run it
   once and schedule it. Then
   [refresh the model from the pipeline](../fabric/pipelines/README.md#refresh-power-bi-from-the-pipeline).
4. **[Deploy the app](../app/README.md#deploy-it-by-hand)** *(optional).* Point `fabric.yaml` at
   your model and run `npx rayfin up`. Then share it.
5. **Add extras** *(optional).* Each has its own steps:

   | Extra | Steps |
   |---|---|
   | Agent 365, Microsoft 365 activity, product feedback, Defender, Azure Resource Graph | [Optional notebooks](../fabric/notebooks/README.md#optional-notebooks), then turn each on in the [pipeline](../fabric/pipelines/README.md#optional-sources) |
   | Credit consumption | [Add Credit Consumption](../fabric/Add%20Credit%20Consumption/README.md) |
   | Agent Evaluator | [Add Agent Evaluator](../fabric/Add%20Agent%20Evaluator/README.md) |
   | Product feedback flow | [flows](../fabric/flows/README.md) |
   | Workday org data | [Workday org data](../fabric/notebooks/workday-org-data/README.md) |

## 3. Verify

1. **The pipeline ran.** In Fabric, open **Monitor** > **Pipeline runs**. Check each activity, not
   just the run: see [If a run fails](../fabric/pipelines/README.md#if-a-run-fails).
2. **The data is there.** Run the `ValueLens_Data_Check` notebook. It shows row counts and date
   ranges, and changes nothing.
3. **The report refreshed.** Open it in Power BI. People show as IDs? See
   [People show as IDs](../fabric/notebooks/README.md#people-show-as-ids).
4. **The app opens** *(if you deployed it).* Each page lists the latest date its sources hold.

Something wrong? See [Troubleshooting](TROUBLESHOOTING.md), including its [known issues](TROUBLESHOOTING.md#known-issues).

## Update

There's no **Repair or change** by hand. For a new version on Fabric:

- **Notebooks:** import the new ones over the old, and fill in the first cell again.
- **Pipeline:** paste the new JSON, fill in the IDs again, and re-add your refresh step. See
  [the pipeline](../fabric/pipelines/README.md#if-a-run-fails).
- **App:** run `npx rayfin up` again from `app`.
- **Secret:** replace it in Key Vault or the notebooks before it expires.

## What you don't get by hand

On Fabric, the installer does these. By hand, you do them yourself or go without:

- The **Analytics Hub Viewers** group and sharing.
- The **Ask** page's Fabric data agent.
- The Power Automate flows and the Cowork Dataflow, set up and named for you.
- The upload router and its folders, and **Upload CSV** for exports.
- Load status cards, **Check status**, **Check the data**, **Rerun failed loads**, secret
  rotation and update checks. These need an [install record](INSTALL.md#run-it).
- Microsoft 365 activity, Defender and Azure Resource Graph in the app, org-scoped access and the
  reporting currency. These need the model the installer builds; the optional notebooks still load
  their data into the Lakehouse.
- The settings for [a large tenant](../fabric/notebooks/README.md#a-large-tenant), set for you.

Want them? Use the [installer](INSTALL.md) instead, in a new workspace.

## Azure

Set up the [Azure version](../azure/README.md) in [Azure Cloud Shell](https://shell.azure.com), in
**Bash**, from the installer's own template, images and report. It needs a release that includes
it, so do **Get the files** before you ask your admins. It's seven steps, plus Teams if you want
it: about an hour, then about an hour more for the first load. When Cloud Shell first asks, mount
a storage account, so your files are kept between sessions.

| Who | What |
|---|---|
| **You** | Owner, or Contributor and User Access Administrator, on the subscription ([Azure roles](PREREQUISITES.md#azure-roles)). Can register apps, for step 2. Power BI Pro, and Power BI Desktop on Windows, June 2024 or later |
| **App admin** (Application Administrator or Cloud Application Administrator) | Approves the web app's delegated permissions: the two `grant` lines in step 3, about a minute |
| **Entra admin** (Global Administrator or Privileged Role Administrator) | Gives the managed identity its Microsoft Graph roles: the rest of step 3, about a minute. Can approve the web app's permissions too |
| **Fabric admin** | Turns on *Service principals can call Fabric public APIs*, *Semantic Model Execute Queries REST API* and *Allow visuals created using the Power BI SDK* ([where](PREREQUISITES.md#fabric-admin-about-5-minutes)). If one is only on for security groups, adds who needs it: the managed identity for the first, after step 1, and the people you let in for the other two |
| **Microsoft 365 admin** | Turns off concealed names in usage reports ([how](PREREQUISITES.md#microsoft-365-admin)) |
| **Teams admin** | Step 8, if you want Teams ([what](PREREQUISITES.md#teams-admin-for-the-teams-app-azure)) |

Paste each block whole. If a command fails, fix the cause and paste the block again: "already
exists" errors are fine. If a block says **Not saved**, it stopped there: fix the cause and paste
it again before Cloud Shell closes. If a new app "doesn't exist", wait a minute. If you're asked to
sign in again, run `az login --use-device-code`.

**Get the files.** This gets the latest release, if it includes Azure by hand and its images are
published. If it says **Not available yet**, use the [installer](INSTALL.md), or try again after
the next release. `my.bicepparam` is your install's record: the steps fill in its IDs.

```bash
get_files() {
  [ -d ~/AnalyticsHub-Dashboard ] || git clone -q https://github.com/microsoft/AnalyticsHub-Dashboard ~/AnalyticsHub-Dashboard || return
  cd ~/AnalyticsHub-Dashboard && git fetch -q --tags || return
  TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest); TAG=${TAG##*/}
  [[ $TAG == installer-v* ]] && git cat-file -e $TAG:azure/infra/web-app-registration.json 2>/dev/null || { echo "Not available yet: the latest release doesn't include it."; return 1; }
  V=$(git show $TAG:installer/package.json | jq -r .version)
  for i in valuelens-jobs valuelens-web; do
    T=$(curl -fsS "https://ghcr.io/token?scope=repository:microsoft/$i:pull" | jq -r .token)
    curl -fsSI -o /dev/null -H "Authorization: Bearer $T" https://ghcr.io/v2/microsoft/$i/manifests/$V || { echo "Not available yet: the $i $V image isn't published."; return 1; }
  done
  git checkout -q --detach $TAG || return
  local R=azure/infra/my.bicepparam
  [ -f $R ] || { cp azure/infra/main.bicepparam $R.new && mv $R.new $R; } || return
  grep -qF '// Keep this line last: it shows this file is complete.' $R || { echo "Not using $R: it's incomplete. Move it aside, paste this again, then put back any IDs it has: mv $R ~/my.bicepparam.old"; return 1; }
  echo "Using $TAG"
}
get_files
```

**Sign in, once.** Run `az login --use-device-code` and pick the subscription. Cloud Shell's own
sign-in can't get tokens for some of the APIs used here. If Conditional Access blocks signing in
with a code, ask whoever manages it.

**Each time Cloud Shell opens**, paste this first. Cloud Shell closes after 20 minutes idle. For
another resource group name, change `analytics-hub` after `RG=`, every time.

```bash
cd ~/AnalyticsHub-Dashboard
RG=analytics-hub; P=azure/infra/my.bicepparam
PBI=https://analysis.windows.net/powerbi/api; API=https://api.powerbi.com/v1.0/myorg
out() { az deployment group show -g $RG -n analytics-hub --query properties.outputs.$1.value -o tsv; }
get() { sed -n -E "s/^(param|var) $1 = '([^']*)'.*/\2/p" $P; }
put() { [ -n "$2" ] || { echo "No value for $1"; return 1; }; v="'$2'"; [[ $2 =~ ^(true|false|[0-9]+)$ ]] && grep -qE "^(// )?param $1 = (true|false|[0-9]+)\b" azure/infra/main.bicepparam && v=$2; sed -i -E "s#^(// )?(param|var) $1 = .*#\2 $1 = $v#" $P && grep -xF -e "param $1 = $v" -e "var $1 = $v" $P || { echo "Not saved in $P: $1 = $v"; return 1; }; }
WEB=$(get webClientId); READER=$(get sqlReaderClientId); WS=$(get workspace); MI=$(out identityPrincipalId 2>/dev/null)
```

1. **Deploy** (about 10 minutes). Change `uksouth` to your region first.
   ```bash
   same() { [ -z "$(get $1)" ] || [ "$(get $1)" = "$2" ] || { echo "Not deployed: $P is for $1 $(get $1), not $2."; return 1; }; }
   deploy() {
     local TN S
     TN=$(az account show --query tenantId -o tsv) && S=$(az account show --query id -o tsv) || return
     same tenant $TN && same subscription $S && same resourceGroup $RG || return
     put tenant $TN && put subscription $S && put resourceGroup $RG || return
     for p in App Sql Storage OperationalInsights ManagedIdentity; do
       az provider register -n Microsoft.$p --wait || return
     done
     az group create -n $RG -l uksouth -o none || return
     az deployment group create -g $RG -n analytics-hub -p $P --query properties.provisioningState -o tsv
   }
   deploy
   ```
   If Azure SQL can't go in that region (`RegionDoesNotAllowProvisioning`), run
   `put sqlLocation <region>` with another region, then paste the block again. If it fails with
   `DenyPublicEndpointEnabled`, an Azure Policy turns off the public network access this setup
   uses. Ask your Azure admin to exempt this resource group, then paste the block again. Or, to
   keep the policy, do **Remove** below, then use the [installer](INSTALL.md) in a new resource
   group: it names the policy and uses private networking.
2. **Register the apps:** the web app people sign in to, and the SQL reader that Power BI reads
   the database as. You need to be able to register apps: everyone can by default, unless *Users
   can register applications* is off. If you can't, the [installer](INSTALL.md) can write a script
   that an Application Administrator or Cloud Application Administrator runs to create them (a
   Privileged Role Administrator can't), and it stops before it deploys anything: see
   [If you can't register apps](../installer/README.md#if-you-cant-register-apps).
   ```bash
   register_apps() {
     FQDN=$(out webFqdn) && MI=$(out identityPrincipalId) && TENANT=$(az account show --query tenantId -o tsv) || return
     sed "s/{{fqdn}}/$FQDN/g" azure/infra/web-app-registration.json > /tmp/web-app.json || return
     [ -n "$WEB" ] || WEB=$(az rest -m POST -u https://graph.microsoft.com/v1.0/applications -b @/tmp/web-app.json --query appId -o tsv)
     put webClientId $WEB && put webAppIdUri api://$FQDN/$WEB || return
     [ -n "$READER" ] || READER=$(az rest -m POST -u https://graph.microsoft.com/v1.0/applications -b '{"displayName": "Analytics Hub SQL Reader"}' --query appId -o tsv)
     put sqlReaderClientId $READER || return
     sleep 30
     az ad app update --id $WEB --identifier-uris api://$FQDN/$WEB
     az ad sp create --id $WEB -o none
     az ad sp create --id $READER -o none
     az ad app federated-credential create --id $WEB --parameters "{\"name\": \"managed-identity\", \"issuer\": \"https://login.microsoftonline.com/$TENANT/v2.0\", \"subject\": \"$MI\", \"audiences\": [\"api://AzureADTokenExchange\"]}" -o none
   }
   register_apps
   ```
3. **Entra admin** (about 2 minutes). Gives the managed identity its read-only Graph roles, and
   consents to the web app's permissions. The `for` loop gives the roles, which needs a Global
   Administrator or Privileged Role Administrator. The two `grant` lines approve the web app's
   delegated permissions, which an Application Administrator or Cloud Application Administrator can
   do too. If that's not you, run `echo "MI=$MI WEB=$WEB"` and send them what it prints and this
   block. They run `az login --use-device-code --allow-no-subscriptions` in Cloud Shell (Bash),
   then paste both.
   ```bash
   GRAPH=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
   for role in AuditLogsQuery.Read.All Reports.Read.All User.Read.All; do
     ID=$(az ad sp show --id $GRAPH --query "appRoles[?value=='$role'].id" -o tsv)
     az rest -m POST -u https://graph.microsoft.com/v1.0/servicePrincipals/$MI/appRoleAssignments -b "{\"principalId\": \"$MI\", \"resourceId\": \"$GRAPH\", \"appRoleId\": \"$ID\"}" -o none
   done
   az ad app permission grant --id $WEB --api 00000009-0000-0000-c000-000000000000 --scope Dataset.Read.All -o none
   az ad app permission grant --id $WEB --api 00000003-0000-0000-c000-000000000000 --scope User.Read -o none
   ```
4. **Publish the report.** This creates the **Analytics Hub (Azure)** workspace, with the managed
   identity as a Member so it can refresh the model.
   ```bash
   make_workspace() {
     [ -n "$WS" ] || WS=$(az rest -m POST -u "$API/groups?workspaceV2=True" --resource $PBI -b '{"name": "Analytics Hub (Azure)"}' --query id -o tsv)
     put workspace $WS || return
     az rest -m POST -u $API/groups/$WS/users --resource $PBI -b "{\"identifier\": \"$MI\", \"principalType\": \"App\", \"groupUserAccessRight\": \"Member\"}" -o none
     cp "fabric/ValueLens - Fabric.pbit" ~/ValueLens.pbit
     echo "Server: $(out sqlServerFqdn)  Database: $(out sqlDatabaseName)"
   }
   make_workspace
   ```
   - In Cloud Shell, choose **Manage files** > **Download**, enter `ValueLens.pbit`, and open it
     in Power BI Desktop, signed in to the tenant you're installing in.
   - Set **Fabric SQL Endpoint** to the server and **Lakehouse Name** to the database. Set
     **Enable_ProductFeedback** and **Enable_Agent365** to `Exclude`. Leave the rest.
   - Select **Load**. Desktop can't load the data from your machine, so it asks you to sign in or
     shows a firewall error: close it. The tables fill in at step 6.
   - Save it as **Analytics Hub Model**, and **Publish** it to **Analytics Hub (Azure)**. If
     Publish times out, publish again.
   - Back in Cloud Shell, save the model's ID and set its parameters again: Desktop puts the
     template's values back when Load fails.
     ```bash
     put model $(az rest -u $API/groups/$WS/datasets --resource $PBI --query "value[?name=='Analytics Hub Model'].id" -o tsv)
     az rest -m POST -u $API/groups/$WS/datasets/$(get model)/Default.UpdateParameters --resource $PBI -b "{\"updateDetails\": [{\"name\": \"Fabric SQL Endpoint\", \"newValue\": \"$(out sqlServerFqdn)\"}, {\"name\": \"Lakehouse Name\", \"newValue\": \"$(out sqlDatabaseName)\"}, {\"name\": \"Enable_ProductFeedback\", \"newValue\": \"Exclude\"}, {\"name\": \"Enable_Agent365\", \"newValue\": \"Exclude\"}]}"
     ```
5. **Create the tables** (about 5 minutes). This deploys again with the new IDs, then makes the
   tables and the SQL reader's database user.
   ```bash
   az deployment group create -g $RG -n analytics-hub -p $P --query properties.provisioningState -o tsv
   az containerapp job start -g $RG -n job-vlens-migrate -o none
   ```
   Then run `az containerapp job execution list -g $RG -n job-vlens-migrate -o table` until it
   shows **Succeeded**.
6. **Load the data** (about an hour).
   - Make the SQL reader a key, which lasts a year:
     `az ad app credential reset --id $READER --append --display-name "Power BI SQL credential"`.
   - In Power BI, open **Analytics Hub Model**'s **Settings** > **Data source credentials** >
     **Edit credentials**. Choose **Service principal**, and enter the `tenant`, the `appId` as
     the ID and the `password` as the key. Set the privacy level to **Organizational**. If the
     database isn't available, it's starting up: try again in a minute.
   - Run `az containerapp job start -g $RG -n job-vlens-run -o none`. It refreshes the model when
     it's done.
7. **Let people in.**
   ```bash
   echo "Users: https://portal.azure.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Users/objectId/$(az ad sp show --id $WEB --query id -o tsv)/appId/$WEB"
   echo "App: $(out webUrl)"
   ```
   - Open the **Users** link and select **Add user/group**. Add yourself as **Analytics Hub
     Admin**, and others as **Analytics Hub User**. Groups need Entra ID P1 or P2. If you can't
     add them, ask an Application Administrator or Cloud Application Administrator.
   - In Power BI, share **Analytics Hub Model** with the same people, with **Allow recipients to
     build content**. They need Power BI Pro.
   - Once the first load is done, open the **App** link.
8. **Teams** *(optional)*.
   ```bash
   node azure/teams/build-package.mjs --client-id $WEB --fqdn $(out webFqdn) --version $(node -p "require('./installer/package.json').version") --out ~/AnalyticsHub-Teams.zip
   ```
   Download `AnalyticsHub-Teams.zip` as in step 4, and give it to a Teams admin to
   [upload](../azure/teams/README.md#if-the-installer-cant-publish-it).

**Extras** *(optional)*. Run its line before step 5, or run step 5 again after it.

| Extra | Line |
|---|---|
| Sample data, not your tenant's | `put sampleData true` |
| [Ask](../azure/README.md#ask) | `az provider register -n Microsoft.CognitiveServices --wait`, then `put askMode create` |
| More history, before step 6 | `put auditHistoryDays 90` (30, 90 or 180 days) |
| Load time, in UTC (03:00 by default) | `put runSchedule '0 6 * * *'` |
| Azure SQL's free offer, before step 1 | `put sqlUseFreeLimit true` |

**Credit consumption** *(optional)*. After step 7, for the
[Consumption Central pages](../azure/README.md#credit-consumption), from exports you upload:

1. Run `put modules core,orgData,consumption`.
2. Give yourself access to the storage account. It can take a few minutes to work.
   ```bash
   az role assignment create --assignee $(az ad signed-in-user show --query id -o tsv) --role "Storage Blob Data Contributor" --scope $(az storage account show -g $RG -n $(out storageAccountName) --query id -o tsv) -o none
   ```
   Then, in the portal, open the storage account's `landing` container. Upload the Power Platform
   admin center's credit CSVs to `studio/`, and the Viva Insights export to `viva/`.
3. **Azure AI costs** *(optional)*. Run `put azureAiSubscriptionId <id>` with the ID of the
   subscription your Azure AI resources are in, then this. It needs Owner or User Access
   Administrator there.
   ```bash
   for r in Reader "Cost Management Reader" "Monitoring Reader"; do
     az role assignment create --assignee-object-id $MI --assignee-principal-type ServicePrincipal --role "$r" --scope /subscriptions/$(get azureAiSubscriptionId) -o none
   done
   ```
4. Publish the second report. Run this, then do as in step 4 with `ConsumptionCentral.pbit`: set
   **FabricSQLEndpoint** to the server and **LakehouseName** to the database, and save it as
   **Analytics Hub Consumption Model**.
   ```bash
   cp "fabric/Add Credit Consumption/Consumption Central - Fabric.pbit" ~/ConsumptionCentral.pbit
   echo "Server: $(out sqlServerFqdn)  Database: $(out sqlDatabaseName)"
   ```
   Then save its ID and set its parameters again, as in step 4:
   ```bash
   put consumptionModel $(az rest -u $API/groups/$WS/datasets --resource $PBI --query "value[?name=='Analytics Hub Consumption Model'].id" -o tsv)
   az rest -m POST -u $API/groups/$WS/datasets/$(get consumptionModel)/Default.UpdateParameters --resource $PBI -b "{\"updateDetails\": [{\"name\": \"FabricSQLEndpoint\", \"newValue\": \"$(out sqlServerFqdn)\"}, {\"name\": \"LakehouseName\", \"newValue\": \"$(out sqlDatabaseName)\"}]}"
   ```
5. Run step 5 again, then step 6 for **Analytics Hub Consumption Model**. Share it as in step 7.

**Check it.** `az containerapp job execution list -g $RG -n job-vlens-run -o table` shows
**Succeeded**, and the app shows data. If not, see [Troubleshooting](TROUBLESHOOTING.md).

**Update.** Paste **Get the files**, then the setup block, then run step 5. If the
[release notes](../CHANGELOG.md) say the report changed, do step 4 again and choose **Replace**
when you publish. Then start a load, as at the end of step 6. Before a year is up, make a new key
and enter it, as in step 6.

**Remove.** Paste the setup block, then this. In the tenant and subscription step 1 recorded, it
deletes the workspace, both apps, and the resource group with everything in it. Paste it again
until it says **Removed**: until then, `my.bicepparam` keeps the IDs of anything it hasn't
deleted. If it never does, because you've lost access or something's already gone, check with
whoever manages them, then delete `my.bicepparam` yourself. Then remove the Teams app, and any
roles you gave on other subscriptions.

```bash
drop() { sed -i -E "s#^(param|var) $1 = .*#\1 $1 = ''#" $P; }
remove_all() {
  local TN=$(get tenant) S=$(get subscription) G=$(get resourceGroup) left=
  local WS=$(get workspace) WEB=$(get webClientId) READER=$(get sqlReaderClientId)
  [ -n "$TN" ] && [ -n "$S" ] && [ -n "$G" ] || { echo "Not removed: $P doesn't say where step 1 deployed."; return 1; }
  az account set -s "$S" && [ "$(az account show --query tenantId -o tsv)" = "$TN" ] ||
    { echo "Not removed: you're not signed in where step 1 deployed. Sign in, then paste this again: az login --use-device-code --tenant $TN"; return 1; }
  [ -z "$WS" ] || { az rest -m DELETE -u $API/groups/$WS --resource $PBI && drop workspace; } || left+=" workspace"
  [ -z "$WEB" ] || { az ad app delete --id $WEB && drop webClientId; } || left+=" web-app"
  [ -z "$READER" ] || { az ad app delete --id $READER && drop sqlReaderClientId; } || left+=" sql-reader"
  [ "$(az group show -n $G --query properties.provisioningState -o tsv)" = Succeeded ] && az group delete -n $G --yes --no-wait
  [ "$(az group exists -n $G)" = false ] || left+=" resource-group"
  if [ -z "$left" ]; then rm $P && echo Removed; else echo "Not removed yet:$left. Paste this again in a few minutes."; return 1; fi
}
remove_all
```

Deleting the resource group takes about 30 minutes, so paste the block again every 5 minutes or
so. The last paste can print a `ResourceGroupNotFound` error just before **Removed**: that's
expected. Remove leaves the Power BI connection that step 6's **Edit credentials** made. It can't
reach anything once the server and the SQL reader are gone.

**What you don't get by hand on Azure.** The installer does these:

- **Check status**, **Repair or change**, update checks, key rotation and **Uninstall**. These
  need an [install record](INSTALL.md#run-it).
- Load status cards, Microsoft 365 activity, Defender, Azure Resource Graph, pay-as-you-go spend
  and the reporting currency. These need the model the installer builds.
- The Agent 365 registry, product feedback and Workday org data, from their CSV exports.
- [Agent Evaluator](../azure/README.md#agent-evaluator), from Copilot Studio transcripts.
- The **Analytics Hub Viewers** group, **Share** in the app, and
  [org-scoped access](PERMISSIONS.md#org-scoped-access-row-level-security). Everyone you let in
  sees all the data.
- The Copilot Studio credits flow. Upload the exports instead.
- Private networking, and publishing the Teams app for you.
- A [least-privilege install](AZURE-LEAST-PRIVILEGE.md) into a resource group your Azure admin creates.

Want them? Use the [installer](INSTALL.md) instead, in a new resource group.

The app still looks for the tables the installer adds, so 400 "Cannot find table" errors in the
browser's developer tools are expected.
