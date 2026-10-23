# Least-privilege Azure install

The Azure install usually needs **Owner**, or **Contributor** and **User Access Administrator**, on
the subscription or resource group: see [Azure roles](PREREQUISITES.md#azure-roles). That still
works. If your Azure admin would rather not give you that, they can prepare one resource group
instead, and give you two roles on just that group:

- **Contributor**, to deploy the resources.
- **Role Based Access Control Administrator**, with a condition that lets you give and remove only
  the four roles the installer gives.

Registering resource providers is subscription-wide, so the admin does that once too. A few roles
sit outside the resource group: the installer prints them, as commands, for the admin.

The Entra, Power BI, Teams and Power Platform rights in [Prerequisites](PREREQUISITES.md) don't
change. Publishing the Teams app to your org's catalog stays optional: a Teams admin can
[upload the package](../azure/teams/README.md#give-it-to-everyone) instead.

## Who does what

| Who | Does | Needs |
|---|---|---|
| Your Azure admin | Creates the resource group, registers the resource providers and gives you the two roles. After the first deploy, gives the managed identity any roles outside the group that the installer printed | **Owner**, or **Contributor** and **User Access Administrator**, on the subscription, and on wherever the roles outside the group go |
| You | Run the installer and, at **Resource group**, pick the admin's group from the list | The two roles, on just that group |

## For your Azure admin

Run this once in [Azure Cloud Shell](https://shell.azure.com) (Bash), or anywhere the Azure CLI is
signed in. Fill in the first four lines.

```bash
set +H   # The condition below has "!" in it, which Bash would otherwise try to expand.

SUB="<subscription ID>"
RG="rg-analytics-hub"
LOCATION="uksouth"
INSTALLER_ID=$(az ad user show --id "installer@contoso.com" --query id -o tsv)   # Or their object ID.
RG_ID="/subscriptions/$SUB/resourceGroups/$RG"

# 1. The resource group.
az group create --subscription "$SUB" --name "$RG" --location "$LOCATION"

# 2. The resource providers every install uses. Microsoft.CognitiveServices is for the Ask model the
#    installer creates (on by default). Registering one that's already registered changes nothing.
for NS in Microsoft.App Microsoft.Sql Microsoft.Storage Microsoft.OperationalInsights \
          Microsoft.ManagedIdentity Microsoft.CognitiveServices; do
  az provider register --subscription "$SUB" --namespace "$NS" --wait
done

# 3. Contributor, on just this group, to deploy the resources.
az role assignment create --assignee-object-id "$INSTALLER_ID" --assignee-principal-type User \
  --role "Contributor" --scope "$RG_ID"

# 4. Role Based Access Control Administrator, on just this group. The condition lets them give and
#    remove only the four roles in the table below, by ID.
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {ba92f5b4-2d11-453d-a403-e96b0029c9fe, 0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3, 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd, 7f951dda-4ed3-4680-a7ca-43fe172d538d})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {ba92f5b4-2d11-453d-a403-e96b0029c9fe, 0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3, 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd, 7f951dda-4ed3-4680-a7ca-43fe172d538d}))"
az role assignment create --assignee-object-id "$INSTALLER_ID" --assignee-principal-type User \
  --role "Role Based Access Control Administrator" --scope "$RG_ID" \
  --condition "$CONDITION" --condition-version "2.0" \
  --description "Analytics Hub installer: only the roles it gives"
```

With private networking, an advanced setting, register these too. The feature can take a while, so
the loop waits for it before registering its provider again.

```bash
az feature register --subscription "$SUB" --namespace Microsoft.Network --name AllowBringYourOwnPublicIpAddress
until [ "$(az feature show --subscription "$SUB" --namespace Microsoft.Network --name AllowBringYourOwnPublicIpAddress --query properties.state -o tsv)" = "Registered" ]; do sleep 60; done
for NS in Microsoft.Network Microsoft.PowerPlatform; do
  az provider register --subscription "$SUB" --namespace "$NS" --wait
done
```

Then send the person installing the subscription and the resource group's name. New roles can take
a few minutes to apply. With Privileged Identity Management, the two roles can be eligible rather
than active, with the same condition: activate both before running the installer.

### The roles the condition allows

| Role | ID | Given to | On | For |
|---|---|---|---|---|
| Storage Blob Data Contributor | `ba92f5b4-2d11-453d-a403-e96b0029c9fe` | The install's managed identity, and you when flows or uploads save files | The storage account | The data, and files saved to its landing container |
| Storage Table Data Contributor | `0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3` | The install's managed identity | The storage account | The app's settings |
| Cognitive Services OpenAI User | `5e0bd9bd-7b93-4f28-af87-19fc36ad61bd` | The install's managed identity | The Ask model's account | Answering questions on the Ask page |
| AcrPull | `7f951dda-4ed3-4680-a7ca-43fe172d538d` | The install's managed identity | Your private container registry, if you use one | Pulling the images from it |

The condition limits which roles, not who gets them. The installer's tests check it against the ARM
template, so a new role in the template means a new condition here.

### In the Azure portal instead

1. Create the resource group, and register the resource providers under the subscription's
   **Settings** > **Resource providers**. For the private networking feature, use the commands above.
2. In the resource group, open **Access control (IAM)** > **Add** > **Add role assignment**, and give
   the person installing **Contributor**.
3. Add another. On the **Privileged administrator roles** tab, pick **Role Based Access Control
   Administrator**. On **Conditions**, choose **Allow user to only assign selected roles to selected
   principals (fewer privileges)** > **Select roles and principals** > **Constrain roles** >
   **Configure**, and pick the four roles above. Or choose **Open advanced condition editor**, set
   **Editor type** to **Code**, and paste the condition from step 4.

## Roles outside the resource group

Some data sources need roles for the install's managed identity outside its resource group. You
can't give them, so during **Checking Azure** the installer prints them, as commands, for your
admin. It leaves out any you can give yourself.

| Role | On | For | Turned on by |
|---|---|---|---|
| **Reader**, **Cost Management Reader** and **Monitoring Reader** | The Azure AI subscription | Azure AI costs and metrics | The **Azure AI costs** card |
| **Cost Management Reader** | Each pay-as-you-go subscription | Copilot pay-as-you-go costs | The **Azure AI costs** card, when billing policies charge there |
| **Reader** | The management group, or the tenant root group | Foundry, from Resource Graph | **Agent configuration and Foundry** |

The managed identity exists once the install has deployed, so on a first install the installer
prints the `az identity list` command that finds it. The install finishes without these roles: when
the installer says it can't give one, choose to leave that source out for now. Once your admin has
given them, run the installer again and say they're there.

A few options need rights in another resource group too:

- **Ask, with an Azure OpenAI deployment you already have** in another resource group: the managed
  identity needs **Cognitive Services OpenAI User** on its account. The installer tries to give it
  after deploying, and prints the command when it can't.
- **Private networking with existing DNS zones** needs **Private DNS Zone Contributor**, for you, on
  the zones' resource group.
- **A private container registry** (`azure.images.registryResourceId`) in another resource group
  needs you to be able to deploy and give AcrPull there. Or keep the registry in the install's group.

## What the installer checks

- **Prerequisites.** Once you've picked an existing resource group, the Azure roles check looks at
  your rights in that group, not just the subscription. Contributor and Role Based Access Control
  Administrator there are *enough to install there*.
- **Checking Azure**, before anything is created:
  - Resource providers it can't register are named, with the commands for your admin. The install
    carries on, and if Azure then refuses to deploy, the installer prints the commands again.
  - If you can't deploy or assign roles in the group, it stops, says what's missing, and lists the
    ways to get it.
  - It prints the roles outside the group, above.

On a new resource group, the subscription is checked instead, as before.

## App registrations

The roles above are Azure roles. They don't let you create Entra app registrations, and the install
needs two: **Analytics Hub (Azure)** and **Analytics Hub SQL Reader**. Everyone can register apps by
default, unless *Users can register applications* is off, and the installer checks before it creates
anything. If you can't, choose **An admin will create the apps for me** under **App registrations**:

| Who | Does | Needs |
|---|---|---|
| You | Run the installer. It writes `analytics-hub-azure-admin-script.md` next to the install record, and stops before it deploys anything | Nothing more |
| Your app admin | Pastes the script into Azure Cloud Shell (Bash). It creates the two apps and their service principals, makes you an owner of them, and approves the web app's delegated permissions. It makes no secrets, and it's safe to run again | **Application Administrator** or **Cloud Application Administrator**. A Privileged Role Administrator can't create app registrations |
| You | Run the installer again. It finds the apps itself, deploys, and finishes the apps as their owner once the web app exists | Owner of the two apps: the script makes you one |

If an admin has already created the apps, choose **Use the apps an admin created for me** instead. If
they created only one of the two, the installer uses it and asks only about the other.
Uninstall leaves apps an admin created, and names them for an admin to delete. See
[If you can't register apps](../installer/README.md#if-you-cant-register-apps).

## Uninstalling

Uninstall deletes the resources the installer tagged, and leaves the admin's resource group and
anything else in it. Your admin deletes the group when it's no longer needed, and removes the roles
they gave outside it. See [Uninstall](UPDATE.md#uninstall) and
[What's left behind](UPDATE.md#whats-left-behind).
