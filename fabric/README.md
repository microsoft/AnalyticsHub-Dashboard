# Fabric

The recommended path. One installer sets everything up in your tenant and gives you the dashboard
as an app in Fabric, called **Analytics Hub**. You don't need a terminal or Power BI Desktop.

[![Download the Analytics Hub installer](https://img.shields.io/badge/Download-Analytics%20Hub%20installer-0078D4?style=for-the-badge)](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)

For Windows 10 or 11. Check [what you need](#before-you-start) first. If your organisation blocks
downloaded exes, use the [PowerShell command](../docs/INSTALL.md#from-powershell) instead. If
your PC can't run either, use [Azure Cloud Shell](../docs/INSTALL.md#locked-down-tenant--azure-cloud-shell).

## Before you start

Go through the **[Prerequisites](../docs/PREREQUISITES.md)**. It lists what you need
and what to ask other admins for, by person, with the optional extras and the costs. In short:

- A **Fabric capacity**, F2 or larger. No capacity?
  [Start a free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).
- Optional: an **Azure subscription** or resource group where you can create a Key Vault. By
  default the app's client secret goes in the notebooks instead, with nothing in Azure. See
  [Where the client secret goes](#where-the-client-secret-goes).
- A **Fabric admin** to turn on four tenant settings, and a **Global Administrator** or
  **Privileged Role Administrator** to grant admin consent. The installer gives you a link to send.
- For Copilot Cowork credits, a **Viva Insights query** built first.
  [Send this to your Viva Insights analyst](../docs/PREREQUISITES.md#send-this-to-your-viva-insights-analyst-first).

It takes about 5 minutes of questions and about 15 minutes of setup. The first data reaches the
app about 25 minutes after you choose **Go ahead** with 30 days of history, or about 2 hours with
180 days. Keep the PC awake and plugged in until it finishes.

Read the [disclaimer](../README.md#disclaimer) too: these aren't the official Copilot reports, and
you're responsible for the data once it's in your workspace.

## Install

1. Start the installer. Paste this into PowerShell:

   ```powershell
   irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
   ```

   Or [download the exe](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)
   and open it. Neither is code-signed yet; to check a download, see
   [Check the download](../docs/INSTALL.md#check-the-download). If your organisation blocks
   them, use another route in [Install](../docs/INSTALL.md) or ask your IT team.
2. The first time, it takes about a minute to unpack.
3. Then it opens in your browser. Keep the installer window open until you're
   done.
4. Choose **Set up Analytics Hub** and sign in with your work account.
5. Answer the questions. Under **Data sources**, choose the data you want: each source has a
   card. Then **Change the advanced settings?** **No** takes the defaults, which suit most
   organisations: see [Advanced settings](../installer/README.md#advanced-settings). **Back** takes
   you to the previous question, with your answer filled in.
6. Check the plan and approve it. Nothing is created until you do.
7. Wait for it to finish. It sets everything up, loads the first data and gives you a link to the
   app.

If admin consent isn't granted yet, the installer skips the first load. Once an admin has granted
it, start the installer again and choose **Run now**.

## Where the client secret goes

The notebooks sign in to Microsoft Graph as the installer's app registration, with its client
secret. Fabric notebooks can't get Graph tokens from a workspace identity, so they need that
secret. The installer asks where to keep it. The default is no Key Vault:

| Choice | What you need | Who can read the secret |
|---|---|---|
| **No Key Vault** (the default) | Nothing in Azure | **Anyone with a role in the workspace**, Viewer included. Key Vault avoids that. |
| **Key Vault** | An Azure subscription or resource group where you can create a vault, or an existing vault | Only people with access to the vault. The notebooks read it at run time. |
| **A vault admin adds it** | Read access to a vault someone else manages | As above. |

With no Key Vault, the secret is written into the notebooks. It lasts 90 days (change it with
`--secret-days`), and each install, repair or update replaces it and removes the old one. The
installer won't write it into a workspace that's connected to Git, and never puts it in the
install record or the logs. Details are in
[Where the secret goes](../installer/README.md#where-the-secret-goes).

### Later: no secret in the notebooks and no Key Vault

Two Fabric features could remove the trade-off. Neither is built yet:

- **Variable library connection references (planned).** A variable library could hold a reference
  to a Fabric connection that stores the secret, and the notebooks would read it with
  `notebookutils.connections.getConnectionRef`. Workspace roles wouldn't expose the secret, and the
  installer could set it up without the manual step a connection needs today. Once
  `getConnectionRef` reaches the Fabric notebook runtime, the plan is to make this the default
  instead of the secret in the notebooks.
- **A Fabric connection bound to each notebook.** This works today with a Web connection and
  `notebookutils.connections.getCredential`, but each notebook has to be bound to the connection
  by hand in the Fabric portal. It may be offered later as an option with a few manual steps.

## Use it

- **Open the app:** in your Fabric workspace, open **Analytics Hub**.
- **Share it.** The installer creates the **Analytics Hub Viewers** group, with you as owner, and
  gives it access to the data. Then:
  1. **Once:** share the app with the group. In the workspace, choose **…** next to the
     **Analytics Hub** app, then **Share**, add **Analytics Hub Viewers** and choose **Grant**. Do
     the same for the **ValueLens** report if you use the Power BI reports.
  2. **To give someone access:** add them to the group in
     [My Groups](https://myaccount.microsoft.com/groups).

  People without access see who to ask. See
  [Viewing Analytics Hub](../docs/PERMISSIONS.md#viewing-analytics-hub-paths-1-and-2).
- **Fresh data:** the pipeline runs on the schedule you chose.
- **Status, updates or repairs:** open the exe again.
- **Items you didn't expect.** If you chose Copilot Cowork credits, Fabric adds items such as
  `DataflowsStagingLakehouse` and `DataflowsStagingWarehouse` to the workspace. Dataflows use them
  behind the scenes. They're expected: leave them alone
  ([Microsoft's note](https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview#staging-items-in-your-workspace)).
- Installs from earlier versions keep the model name `ValueLens Model`.

## Optional extras

Copilot usage, licences and org data are always collected. Choose any of these on the
installer's **Data sources** screen, where each one is a card. Each has a few steps of its own:
see [Optional extras](../docs/PREREQUISITES.md#optional-extras) for what each one needs.

| Card | What it shows | Where the data comes from |
|---|---|---|
| [Microsoft 365 activity](../installer/README.md#microsoft-365-activity) *(on by default)* | How people work across Teams, Outlook, SharePoint, OneDrive and the Office apps | Microsoft 365 usage reports |
| [Agent 365 registry](../installer/README.md#data-sources-and-exports) | The agents in your tenant and who made them | The Agent 365 API, or the Microsoft 365 admin center export |
| [Product feedback](../installer/README.md#power-automate-flows) | What people say about Copilot | The Microsoft 365 admin center export, saved by a flow or uploaded |
| [Credit consumption](../installer/README.md#credit-consumption): **Copilot Studio credits**, **Copilot Cowork credits** and **Azure AI costs** | Credits used and what they cost across Copilot Studio, Copilot Cowork and Azure AI | Copilot Studio credits from a daily flow on the Power Platform licensing API (exports from the Power Platform admin center are optional), Cowork credits from a Viva Insights query through a Dataflow (or its CSV export), and Azure AI and pay-as-you-go costs from Azure |
| [Agent Evaluator](../installer/README.md#agent-evaluator) | How well your Copilot Studio agents work: how conversations end, topics, knowledge, errors and user feedback | Copilot Studio conversation transcripts in Dataverse |
| [Defender (shadow AI and agent risk)](../installer/README.md#defender-shadow-ai-and-agent-risk) | AI tools other than Copilot in use on your devices and network, and agents that answer without sign-in | Microsoft Defender advanced hunting and Cloud Discovery |
| [Agent configuration and Foundry (Azure Resource Graph)](../installer/README.md#agent-configuration-and-foundry) | How each Copilot Studio agent is set up, and your Foundry resources | Azure Resource Graph |

## Prefer Power BI Desktop?

To build your own reports, connect Power BI Desktop to `Analytics Hub Model` (or `ValueLens Model`)
in your workspace.

To use a template instead, choose not to deploy the model in the installer's **Power BI** step.
When it finishes, it shows the values to enter in
[`ValueLens - Fabric.pbit`](ValueLens%20-%20Fabric.pbit) (SQL endpoint) or
[`ValueLens - Fabric OneLake.pbit`](ValueLens%20-%20Fabric%20OneLake.pbit) (OneLake).
Publish the report, then
[add a refresh step to the pipeline](pipelines/README.md#refresh-power-bi-from-the-pipeline).

## Set it up by hand

If you can't use the installer, follow [Manual install](../docs/MANUAL-INSTALL.md): prerequisites,
install and verify, step by step. It uses the same files the installer does.

This video walks through the manual setup, from a fresh app registration to a saved,
self-refreshing Power BI report. You don't need it if you use the installer.

https://github.com/user-attachments/assets/c834bed3-49fa-4f6a-bc7a-01bded2fd53e

> Prefer to download it? [Get the walkthrough video](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot/releases/download/installer-v0.2.2/ValueLens_Fabric_Setup.mp4).

## Problems

See [Troubleshooting](../docs/TROUBLESHOOTING.md), including its [known issues](../docs/TROUBLESHOOTING.md#known-issues).
