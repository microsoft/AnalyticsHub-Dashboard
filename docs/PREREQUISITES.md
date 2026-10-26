# Prerequisites

What you need before you install, and who to ask. Send each admin their row before you start,
so you don't stop halfway. Once you sign in, the installer's **Prerequisites** panel (`prereqs`)
checks most of it for you, and changes nothing. You don't have to run it first: install and update
check the same things before they create or change anything, and list only what's missing for what
you chose. Each check has 15 seconds; one that takes longer shows as "couldn't check" and never
stops you. A **Hand-off** (→ in the terminal) is work someone else does for you, such as an admin
approving the app's permissions: the row says who, install and update list it on its own line, and
the install carries on. Only a true blocker stops an install: with `--yes`, no way to register the app (you
can't, and there's no app registration or admin pack to use instead). Setting it up by hand? On Fabric, you also need
[these](MANUAL-INSTALL.md#1-prerequisites); on Azure, see [its list](MANUAL-INSTALL.md#azure).

## At a glance

| Who | Fabric | Azure | Time |
|---|---|---|---|
| **You**, who run the installer | Contributor on an F2 or larger capacity, or a [free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager), or an Admin or Member of a workspace already on a capacity. Power BI Pro. Can register an app. | Owner, or Contributor and User Access Administrator, on a subscription or resource group. Power BI Pro. Can register an app. | 20 min |
| **Fabric admin** | Turns on, or confirms, [the tenant settings](#fabric-admin-about-5-minutes), including letting you create Fabric items | Turns on, or confirms, the tenant settings | 5 min |
| **Entra admin** (Global Administrator or Privileged Role Administrator) | Grants admin consent for read-only Graph permissions | The same, for the app and the managed identity. Plus one to manage viewers from the web app | 2 min |
| **Microsoft 365 admin** (Global Administrator) | Turns off concealed names in usage reports | The same | 1 min |
| **Compliance admin** | Makes sure audit logging is on in Microsoft Purview (it usually is) | The same | 1 min |
| **Teams admin** | – | Publishes the Teams app to your org's app catalog | 2 min |
| **Viewers** | In the Analytics Hub Viewers group. Power BI Pro below F64. | In the group. Power BI Pro. | – |

One person can be several of these. If you're the Fabric admin, Entra admin or Teams admin
yourself, the installer does their part.

- **Runs on** Windows 10 or 11, with [the exe or the PowerShell one-liner](INSTALL.md), or in
  [Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell) from any browser. No admin
  rights on the PC.
- **No Key Vault needed.** On Fabric the app's secret goes in the notebooks by default, so nothing
  in Azure is needed. A Key Vault is optional: see [Where the secret goes](../installer/README.md#where-the-secret-goes).
- **Azure region preflight.** Only regions that Azure Policy allows, and where every resource can
  go, are offered. The installer says why it left the others out.
- **Private networking** (Azure, optional), for where policy keeps public access off. It needs a
  Fabric or Premium capacity for the VNet data gateway, and adds about $30–40 a month. See
  [Networking](../installer/README.md#networking).
- **Extras** may need a Power Platform admin or a Viva Insights analyst. See
  [Optional extras](#optional-extras).

## How long it takes

| Step | Time |
|---|---|
| Answering the questions | About 5 minutes |
| Setting up, after you choose **Go ahead** | About 15 minutes |
| First data in the app, with 30 days of history | About 25 minutes after **Go ahead** |
| First data in the app, with 180 days of history | About 2 hours after **Go ahead** |
| Copilot Studio credits | After the Studio flow's first run. Run it straight away, or it runs the next day |

A tenant with more than 10,000 people takes longer: see [A large tenant](../installer/README.md#a-large-tenant).

**Keep this PC awake and plugged in** until the installer says it's finished, and keep the
installer window open. If the PC sleeps, setup stops until it wakes.

## Permissions

Every Graph permission is read-only, except one the web app uses on your behalf to manage viewers,
and one the installer uses on Azure to publish the Teams app.
Rows marked *(Optional.)* are only added when you turn on what they're for. For more detail, see
[Permissions](PERMISSIONS.md).

### Analytics Hub Data Collector (Fabric)

The app registration the daily loads sign in as. Application permissions, with admin consent.

| API | Permission | Reason |
|---|---|---|
| Graph | `AuditLogsQuery.Read.All` | Reading Copilot audit events |
| Graph | `Reports.Read.All` | Reading Copilot licences and Microsoft 365 usage reports |
| Graph | `User.Read.All` | Reading people's department, job title, manager and location |
| Graph | `CopilotPackages.Read.All` | *(Optional.)* Reading the Agent 365 registry. Turned on by the **Agent 365 registry** card, set to **Connected**. Without it, the registry uses its CSV export |
| Graph | `Application.Read.All` | *(Optional.)* Finding each agent's owner. Turned on by the **Agent 365 registry** card, set to **Connected** |
| Graph | `ThreatHunting.Read.All` | *(Optional.)* Finding AI tools on devices, and agent risk, with Defender advanced hunting. Turned on by the **Defender** card |
| Graph | `CloudApp-Discovery.Read.All` | *(Optional.)* Finding AI apps in use on the network, with Cloud Discovery. Turned on by the **Defender** card |

### Collector managed identity (Azure)

What the scheduled jobs sign in as. Graph app roles, granted by an Entra admin.

| API | Permission | Reason |
|---|---|---|
| Graph | `AuditLogsQuery.Read.All` | Reading Copilot audit events |
| Graph | `Reports.Read.All` | Reading Copilot licences and Microsoft 365 usage reports |
| Graph | `User.Read.All` | Reading people's department, job title, manager and location |
| Graph | `ReportSettings.Read.All` | *(Optional.)* Reading the usage reports' settings. Turned on by the **Microsoft 365 activity** card (on by default) |
| Graph | `ThreatHunting.Read.All` | *(Optional.)* Finding AI tools on devices, and agent risk. Turned on by the **Defender** card |
| Graph | `CloudApp-Discovery.Read.All` | *(Optional.)* Finding AI apps in use on the network. Turned on by the **Defender** card |
| Graph | `Sites.Selected` | *(Optional.)* Reading the files dropped in the SharePoint folder you name: credit files, and the Agent 365, product feedback and Workday exports. Turned on with private networking. A SharePoint or Global admin who's a member of the site also gives it **Read** on it, by hand |

### Analytics Hub web app (Azure)

The app registration people sign in to. Delegated permissions: it acts as the person using it.

| API | Permission | Reason |
|---|---|---|
| Power BI | `Dataset.Read.All` | Querying the models as the person viewing, so they see only what they can |
| Graph | `User.Read` | Signing people in |
| Graph | `GroupMember.ReadWrite.All` | *(Optional.)* Letting group owners and admins add viewers from **Share** in the app. Turned on by the viewer group (the default). Graph still only lets owners and admins change the group |
| Graph | `User.ReadBasic.All` | *(Optional.)* Letting **Share** find people by email and show viewers' names. Turned on by the viewer group (the default). It reads only basic profiles: name, email address and photo |

The web app also has two app roles, **AnalyticsHub.User** and **AnalyticsHub.Admin**. A second
app registration, the SQL reader, is the Power BI refresh's sign-in to Azure SQL. It can only read
the database and has no API permissions.

### The installer's Teams sign-in (Azure)

A second sign-in, to **Microsoft Graph Command Line Tools**, so the installer can publish the Teams
app for you. A delegated permission: it acts as you.

| API | Permission | Reason |
|---|---|---|
| Graph | `AppCatalog.ReadWrite.All` | Publishing the Teams app to your org's app catalog, and updating or deleting it on later runs. Asked for when you're a Teams Administrator or Global Administrator. It needs admin consent, which a Global Administrator, Privileged Role Administrator, Cloud Application Administrator or Application Administrator gives at the prompt. Without it, a Teams admin uploads the package by hand |

### Azure roles

| Scope | Role | Reason |
|---|---|---|
| Subscription or resource group | **Owner**, or **Contributor** and **User Access Administrator**, for you | Deploying the resources and giving the managed identities their roles. Azure only |
| Resource group your Azure admin creates | **Contributor**, and **Role Based Access Control Administrator** limited to the roles the installer gives, for you | The [least-privilege](AZURE-LEAST-PRIVILEGE.md) alternative to the row above. Your Azure admin creates the group, registers the resource providers and gives you these. Azure only |
| Storage account | **Storage Blob Data Contributor**, for you | *(Optional.)* Saving files to the landing container. Turned on by **Copilot Studio credits** or **Copilot Cowork credits**, the agent inventory flow (without a SharePoint folder), or org-scoped access. Azure only; the installer gives it |
| Azure AI subscription | **Reader**, **Cost Management Reader** and **Monitoring Reader**, for the app or managed identity | *(Optional.)* Reading Azure AI costs and usage. Turned on by the **Azure AI costs** card |
| Each pay-as-you-go subscription | **Cost Management Reader**, for the app or managed identity | *(Optional.)* Reading Copilot pay-as-you-go costs. Turned on by the **Azure AI costs** card, when billing policies charge there |
| Management group, or the tenant root group | **Reader**, for the app or managed identity | *(Optional.)* Reading Foundry accounts and projects. Turned on by **Agent configuration and Foundry** |
| AI Services or Azure OpenAI account | **Cognitive Services OpenAI User**, for the web app's managed identity | *(Optional.)* Answering questions on the Ask page. Turned on by Ask (on by default on Azure) |
| Hub resource group with the private DNS zones | **Private DNS Zone Contributor**, for you | *(Optional.)* Linking the network to existing zones. Turned on by private networking with **Use existing zones** |
| Key Vault | **Key Vault Secrets Officer**, or an access policy with Get, List and Set, for you | *(Optional.)* Writing the app's secret. Turned on by choosing Key Vault on Fabric. To only read it, **Key Vault Secrets User** |

Apart from your own roles in the first two rows, the installer gives these when you can assign roles
there. Otherwise it gives you the command for someone who can.

### Other roles

| Scope | Role | Reason |
|---|---|---|
| Fabric capacity | **Contributor**, for you | Putting the workspace on it. Not needed if you use a workspace that's already on a capacity, as its Admin or Member. Fabric only |
| Fabric workspace | **Viewer**, for the app | Letting the models read the Lakehouse. Fabric only; the installer gives it |
| Fabric workspace | **Contributor**, for whoever signs in to the flows' OneLake connection | *(Optional.)* Saving files from the flows. With `--flow-identity app`, the app gets it instead |
| Semantic models | **Build**, for the Analytics Hub Viewers group | Letting viewers query the models. The installer gives it |
| Power BI workspace | **Member**, for the managed identity | Refreshing the models. Azure only; the installer gives it |
| Entra directory | **Global Reader**, for the app or managed identity | *(Optional.)* Reading how each Copilot Studio agent is set up, from Azure Resource Graph. Turned on by **Agent configuration and Foundry**. Power Platform Administrator or AI Administrator also work |
| Each Power Platform environment you pick | **Bot Transcript Viewer** and the installer's **Analytics Hub transcript reader** role, for the app or managed identity as an application user | *(Optional.)* Reading Copilot Studio transcripts. Turned on by **Agent Evaluator**. Bot Transcript Viewer alone reads only the transcripts the application user owns, or that are shared with it, so the installer also creates a role for the install, in the root business unit, that holds only ConversationTranscript read at Organization depth. Adding the user, and creating and giving the role, need System Administrator in the environment; the installer does them if you're one. On Azure it's the jobs' managed identity, which an admin finds by its client ID |

## Send this to your Viva Insights analyst first

Only if you want **Copilot Cowork credits** from Viva Insights. The installer asks for the query's
IDs, and building the query can take a while, so ask for it now. Copy this:

> Hi, I'm setting up Analytics Hub, which reports Copilot Cowork credits from Viva Insights.
> Could you build a query for it?
>
> 1. In [Viva Insights](https://analysis.insights.viva.office.com/), go to **Create analysis** >
>    **Create custom query** > **Consumption query**. Keep the preselected credit metrics, add no
>    conditions, and turn on **Auto-refresh**. Then select **Run**.
> 2. Once it shows **Success**, go to **Analysis results**, choose the **link icon** next to the
>    query, and copy its **partition ID** and **query ID**.
> 3. Send me both IDs. Later, I'll ask you to sign in to a Fabric Dataflow that reads the query.
>
> You need the Viva Insights **Insights Analyst** role. Step by step:
> [Running the Viva Insights query](https://github.com/microsoft/AnalyticsHub-Dashboard/blob/main/docs/VIVA-QUERY.md).
> Microsoft's guide:
> [Export query data to Microsoft Fabric](https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric).

The installer fills in the partition ID with your tenant ID, which is usually right. No query
yet? Carry on: choose **Not yet** to **add the query later**. Until then, Cowork credits come
from the Copilot Consumption Dashboard's CSV export. Once you have the IDs, open the installer
again and choose **Repair or change**.

## Checklist, by person

The detail behind [At a glance](#at-a-glance), with links to Microsoft Learn.

### You: the person who runs the installer

- [ ] **Windows 10 or 11** (64-bit), or [Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell),
      or [Node.js](INSTALL.md#without-the-exe) on another system. In Cloud Shell, you sign in with a
      code, which a Conditional Access policy can block. If yours does, run the installer on a PC
      that's allowed, or ask whoever manages Conditional Access. See
      [Locked-down tenant / Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell).
- [ ] **Fabric:** a Fabric capacity you can use. To create the workspace on a capacity, you need to
      be its admin or a Contributor on it: ask its capacity admin, or start a
      [free trial](#what-it-costs). Or be an Admin or Member of a workspace that's already on a
      capacity: the installer then puts Analytics Hub in that workspace, but can't create a new one,
      or check the capacity's size or state. With `--yes`, that works only for the workspace the
      install record already names.
- [ ] **Azure:** [Owner](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#owner),
      or [Contributor](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#contributor)
      and [User Access Administrator](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#user-access-administrator),
      on a subscription or resource group, and a Power BI workspace you can create or use. Or, for
      [least privilege](AZURE-LEAST-PRIVILEGE.md), Contributor and a limited Role Based Access
      Control Administrator on just a resource group your Azure admin creates.
- [ ] **[Power BI Pro or Premium Per User](https://learn.microsoft.com/power-bi/fundamentals/service-features-license-type)**,
      to publish the models and reports.
- [ ] **Permission to register an app** in Microsoft Entra ID. Everyone can by default
      ([who can](https://learn.microsoft.com/entra/identity/role-based-access-control/delegate-app-roles#restrict-who-can-create-applications)).
      If you can't, an admin registers it with the [admin pack](../installer/README.md#if-you-cant-register-apps).
- [ ] **Optional: a Key Vault for the app's secret** (Fabric). By default, the installer writes
      the secret into the notebooks: nothing in Azure is needed, but anyone with a role in the
      workspace can read it. See [Where the secret goes](../installer/README.md#where-the-secret-goes).

### Fabric admin: about 5 minutes

- [ ] **Fabric: a capacity.** An F2 or larger [Fabric capacity](https://learn.microsoft.com/fabric/enterprise/licenses#capacity),
      or a [free trial](#what-it-costs). Use **F64 or larger** for a tenant with more than 10,000
      people. Its capacity admin makes the person who runs the installer a **Contributor** on it.
      Or a workspace's Admin makes them an Admin or Member of a workspace that's already on a
      capacity. A Premium P capacity works too, but **Premium Per User (PPU)** workspaces can't
      hold notebooks or Lakehouses.
- [ ] **Tenant settings** turned on, in Fabric under **Admin portal** > **Tenant settings**
      ([all tenant settings](https://learn.microsoft.com/fabric/admin/tenant-settings-index)).
      They can be on for the whole organisation, or just for security groups. If just for groups,
      who needs each one has to be in one of them. Only a Fabric admin can read them, so if you
      aren't one, the installer lists the ones to confirm:
  - [*Users can create Fabric items*](https://learn.microsoft.com/fabric/admin/fabric-switch), for
    the person who runs the installer: for the whole organisation, a security group they're in, or
    [delegated](https://learn.microsoft.com/fabric/admin/capacity-settings#delegated-tenant-settings)
    to the capacity. Without it, Fabric says *Unable to create Import notebook* (or Lakehouse).
    It can take about 15 minutes to apply. Fabric only.
  - [*Create workspaces*](https://learn.microsoft.com/fabric/admin/portal-workspace#create-workspaces),
    for the person who runs the installer, when the installer creates the workspace. Fabric and
    Azure.
  - [*Service principals can call Fabric public APIs*](https://learn.microsoft.com/fabric/admin/service-admin-portal-developer#service-principals-can-call-fabric-public-apis).
    Lets the daily loads run on their own. Fabric and Azure. Needed by the app registration
    (Fabric) or the managed identity (Azure).
  - [*Semantic Model Execute Queries REST API*](https://learn.microsoft.com/fabric/admin/service-admin-portal-integration#semantic-model-execute-queries-rest-api).
    Lets the app's pages query the model, as the person using them. Fabric and Azure. Needed by
    the people who use the app.
  - [*Allow visuals created using the Power BI SDK*](https://learn.microsoft.com/fabric/admin/service-admin-portal-power-bi-visuals#allow-visuals-created-using-the-power-bi-sdk),
    for the Power BI reports, or some visuals stay blank. Fabric and Azure. Needed by the people
    who open the reports.
  - The Fabric apps setting, under [**Fabric apps (preview)**](https://learn.microsoft.com/fabric/apps/create-app).
    Lets the installer create the Analytics Hub app in Fabric. Fabric only. Needed by whoever
    runs the installer.
  - [*Allow XMLA endpoints and Analyze in Excel with on-premises semantic models*](https://learn.microsoft.com/fabric/admin/service-admin-portal-integration#allow-xmla-endpoints-and-analyze-in-excel-with-on-premises-semantic-models),
    only with [org-scoped access](PERMISSIONS.md#org-scoped-access-row-level-security), which
    applies the models' role members through it. Fabric and Azure. The capacity's XMLA endpoint
    must also be [Read Write](https://learn.microsoft.com/fabric/enterprise/powerbi/service-premium-connect-tools#enable-xmla-read-write),
    which a capacity admin sets.
- [ ] **Leave on** [*Users can access data stored in OneLake with apps external to Fabric*](https://learn.microsoft.com/fabric/admin/service-admin-portal-onelake#users-can-access-data-stored-in-onelake-with-apps-external-to-fabric).
      It's on by default. The Power Automate flows need it.

If you're a Fabric admin yourself, the installer reads these settings and says which are off,
apart from *Users can create Fabric items*, *Create workspaces* and the XMLA one.

### Power Platform admin: for the Copilot Studio credits flow

Only if you want **Copilot Studio credits** through the daily flow, or the optional product
feedback or agent inventory flows.

- [ ] **An environment for the flows.** Usually the default environment. The person who runs the
      installer needs to be able to create flows there (the Environment Maker role).
      [About environments](https://learn.microsoft.com/power-platform/admin/environments-overview).
- [ ] **Data policies allow the connector.** If the environment has
      [data policies](https://learn.microsoft.com/power-platform/admin/prevent-data-loss) (also
      called DLP), they must allow
      [**HTTP with Microsoft Entra ID (preauthorized)**](https://learn.microsoft.com/connectors/webcontents/).
      For the product feedback flow, it must be in the same group as **Office 365 Outlook**.
- [ ] **A Power Automate Premium licence** for whoever signs in to the Copilot Studio credits flow.
      HTTP with Microsoft Entra ID is a premium connector.
      [Licence types](https://learn.microsoft.com/power-platform/admin/power-automate-licensing/types).
- [ ] **Someone signs in to the flow** once, after the install, as a Power Platform Administrator,
      Billing Administrator or Global Administrator. Often the same person.

### Viva Insights analyst: for Copilot Cowork credits

Only if you want **Copilot Cowork credits** from Viva Insights. Send them
[the note above](#send-this-to-your-viva-insights-analyst-first) first.

- [ ] Has the [Insights Analyst](https://learn.microsoft.com/viva/insights/advanced/setup-maint/assign-user-roles)
      role. A Global Administrator assigns it in the Microsoft 365 admin center, under **Settings** >
      **Viva** > **Viva Insights**, or **Role assignments**. If your organisation uses Privileged
      Identity Management, a Privileged Role Administrator can assign it there. You don't need the
      role yourself if an analyst does the two items below for you.
- [ ] Builds the query and sends you its partition ID and query ID, **before you start**. See
      [Running the Viva Insights query](VIVA-QUERY.md).
- [ ] Signs in to the `AnalyticsHub_Cowork_Credits` Dataflow once, when the installer asks. It
      asks early in the install, before the notebooks and the first load, and checks the sign-in
      worked. If it's you who has the role, sign in then. See
      [Credit consumption](../installer/README.md#credit-consumption).

### Entra admin: about 2 minutes

A [Global Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#global-administrator)
or [Privileged Role Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#privileged-role-administrator),
the Entra roles that can approve app permissions and give roles to apps. If you're one of them,
the installer does this itself, and you can skip this section.

- [ ] **Grant admin consent** for the [Graph permissions](#permissions) above. All are read-only,
      except `GroupMember.ReadWrite.All` on the Azure web app, which lets group owners and admins
      add viewers from the app, and `AppCatalog.ReadWrite.All`, which lets the installer publish
      the Teams app. The web app's `User.ReadBasic.All` lets **Share** find people by email, and
      reads only basic profiles. The installer gives you a link to send for the app's permissions.
      The Teams one is given at the installer's second sign-in, by whoever runs it.
      [About admin consent](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent).
- [ ] **Optional: give the app or managed identity the Global Reader role**, only for agent
      configuration from Azure Resource Graph.
      [Global Reader](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#global-reader)
      can read settings but change nothing. The installer gives you a message to send, with a link.

Some organisations make admins switch a role on before they use it (Privileged Identity
Management). If yours does, switch the role on first, then sign in to the installer. A role that's
not switched on shows as **can be activated** in the Prerequisites panel.

Without consent for `AuditLogsQuery.Read.All`, the audit load reads nothing. The installer checks
the app's token for it straight after consent, and the Prerequisites panel's **Audit log access
for Copilot interactions** row shows whether it's in place. It must be an **Application**
permission, not Delegated.

### Compliance admin: audit logging

A [Compliance Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#compliance-administrator),
or anyone with the Audit Logs role in Purview. Audit logging is on by default, so this is usually
already done.

- [ ] **Check audit logging is on.** Open [Microsoft Purview > Audit](https://purview.microsoft.com/audit/auditsearch).
      If it offers **Start recording user and admin activity**, audit logging is off: select it.
      New records then take from 60 minutes to 24 hours to appear.
      [About audit logging](https://learn.microsoft.com/purview/audit-log-enable-disable).

To test it end to end, run `check-audit` once the app has consent. It searches the audit log as the
app, and says whether it found Copilot interactions, other records only, or nothing at all.

If the audit load already ran before consent or audit logging was fixed, it has marked those days
as read and empty: it reuses an empty window for 6 hours, and never reads one older than 7 days
again. To reload them on Fabric, rename `Files/_audit_staging/_manifest.json` in the Lakehouse (for
example to `_manifest.old.json`), then run `run --backfill-days <n>`, with `<n>` covering the days
to reload. The Azure jobs keep no such manifest.

### Microsoft 365 admin

- [ ] **Show real names in usage reports**, for Microsoft 365 activity (on by default). A
      [Global Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#global-administrator),
      in the Microsoft 365 admin center, goes to **Settings** > **Org settings** > **Services** >
      **Reports** and unticks **Conceal user, group, and site names in all reports**.
      [Why](https://learn.microsoft.com/troubleshoot/microsoft-365/admin/miscellaneous/reports-show-anonymous-user-name).
- [ ] **Schedule the product feedback export**, only if you want product feedback through the flow.
      In the Microsoft 365 admin center, go to **Health** > **Product feedback** and schedule the
      export to be emailed to the flow's mailbox, with the subject `Copilot Product Feedback`. This
      needs a Global Administrator or [Reports Reader](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#reports-reader).
      [About product feedback](https://learn.microsoft.com/microsoft-365/admin/misc/feedback-user-control#how-can-i-see-my-users-feedback).

### Teams admin: for the Teams app (Azure)

A [Teams Administrator](https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference#teams-administrator)
or Global Administrator. If you run the installer as one of them, it publishes the app for you
after a [second sign-in](#the-installers-teams-sign-in-azure), and you can skip the first item.

- [ ] **Publish the Teams app**, if the installer couldn't. It prints the steps: in the
      [Teams admin center](https://admin.teams.microsoft.com/policies/manage-apps), go to
      **Teams apps** > **Manage apps**, select **Upload new app** > **Upload**, and choose
      `AnalyticsHub-Teams.zip`. See [Give it to everyone](../azure/teams/README.md#give-it-to-everyone).
- [ ] **Allow it**, if your organisation limits custom apps: the custom app setting in
      [org-wide app settings](https://learn.microsoft.com/microsoftteams/manage-apps#manage-org-wide-app-settings),
      and the viewers' [app permission policy](https://learn.microsoft.com/microsoftteams/teams-app-permission-policies).
- [ ] **Optional: pin it** for the **Analytics Hub Viewers** group, with an
      [app setup policy](https://learn.microsoft.com/microsoftteams/teams-app-setup-policies).

### People who view the app

- [ ] [Power BI Pro or Premium Per User](https://learn.microsoft.com/power-bi/fundamentals/service-features-license-type),
      unless the workspace is on an [F64 or larger capacity](https://learn.microsoft.com/fabric/enterprise/licenses#per-user-or-individual-licenses).
- [ ] Membership of the **Analytics Hub Viewers** group. See [Share it](../fabric/README.md#use-it).

## Optional extras

Copilot usage, licences and org data are always collected. Each extra is a card on the
installer's **Data sources** screen. Pick only the ones you want: what you skip stays empty, and
nothing fails.

| Card | What it needs, beyond the checklist |
|---|---|
| **Microsoft 365 activity** *(on by default)* | Real names in usage reports (a Global Administrator). |
| **Agent 365 registry** | An [Agent 365](https://learn.microsoft.com/microsoft-agent-365/overview) licence for **Connected**, which is Fabric only for now. Without one, or on Azure, upload the export from the Microsoft 365 admin center. On Azure you drop it in the landing folder: see [Agent 365 registry](../azure/README.md#agent-365-registry). |
| **Product feedback** | No API. With the flow: a Power Automate Premium licence, a mailbox for the exports, and the export schedule (Microsoft 365 admin). Or upload the export yourself. The flow and the upload are Fabric only for now: on Azure you drop the exports in the landing folder, see [Product feedback](../azure/README.md#product-feedback). |
| **Workday org data** | A Workday report of active workers with **Primary Work Email**, uploaded as a CSV. |
| **Credit consumption** | Three cards, below. |
| ↳ **Copilot Studio credits** | The Power Platform admin items above: environment, data policies, Premium licence and the sign-in. Or upload the exports from the Power Platform admin center each month. |
| ↳ **Copilot Cowork credits** | The Viva Insights query (Viva Insights analyst). The Dataflow that reads it is Fabric only. Or upload the Copilot Consumption Dashboard's export. |
| ↳ **Azure AI costs** | [Owner](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#owner) or [User Access Administrator](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged#user-access-administrator) on the subscription, so the installer can give the read-only cost roles. Otherwise someone with that role gives them. |
| **Agent Evaluator** | [System Administrator](https://learn.microsoft.com/power-platform/admin/database-security) in each Power Platform environment you pick. Pick environments that save transcripts: not developer or Dataverse for Teams ones. The installer adds the app (Fabric) or the jobs' managed identity (Azure) as an application user with the [Bot Transcript Viewer](https://learn.microsoft.com/microsoft-copilot-studio/analytics-transcripts-powerapps) role, creates a security role there that reads every conversation transcript and nothing else, and gives it that role too. Creating the role, setting its privileges and deleting it on uninstall need the Create, Write and Delete privileges on security roles, which System Administrator has. Installs from before 0.6.8 get the role on **Update** or **Repair or change**, which needs the same. Otherwise a System Administrator does it: see [Agent Evaluator](../installer/README.md#agent-evaluator). |
| **Defender (shadow AI and agent risk)** | [Defender for Endpoint P2](https://learn.microsoft.com/defender-endpoint/minimum-requirements) or [Defender XDR](https://learn.microsoft.com/defender-xdr/prerequisites) for devices and agents, and [Defender for Cloud Apps](https://learn.microsoft.com/defender-cloud-apps/set-up-cloud-discovery) for Cloud Discovery. A part you aren't licensed for is skipped. |
| **Agent configuration and Foundry (Azure Resource Graph)** | Azure [Reader](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/general#reader) on the [tenant root group](https://learn.microsoft.com/azure/governance/management-groups/overview) or a management group (someone who's an Owner there), and **Global Reader** (Entra admin). The agent inventory flow needs the Power Platform admin items above. |
| **Ask data agent** (advanced settings) | Fabric: a paid F2 or larger capacity, not a trial, and the tenant settings for data agents and Copilot. Azure: an Azure OpenAI model, which the installer creates by default. See [Ask](../installer/README.md#ask). |
| **GitHub Copilot credits** | Not in the installer. A GitHub [personal access token](https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) with `manage_billing:enterprise`, or the AI usage report export. See [Add Credit Consumption](../fabric/Add%20Credit%20Consumption/README.md). Fabric only. |

## What it costs

Analytics Hub itself is free. It runs on services your organisation pays for: a Fabric capacity,
or Azure resources at about $5–40 a month for a small tenant. Viewers need Power BI Pro below
F64. See [Running costs](ARCHITECTURE.md#running-costs) for the full list and pricing links.

**Fabric free trial.** 60 days, at no cost:
[start a free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).
Before it ends, move the workspace to a paid capacity, or its notebooks and pipeline stop.
