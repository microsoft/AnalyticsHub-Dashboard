# FAQ

Short answers. Each links to the page with the detail.

## Is this the official Copilot report?

No. The official numbers are in the
[Microsoft 365 admin center Copilot reports](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-usage)
and the [Viva Insights Copilot Dashboard](https://learn.microsoft.com/en-us/viva/insights/org-team-insights/copilot-dashboard).
Analytics Hub adds history, your org structure, agents, value and cost on top. See the
[disclaimer](../README.md#disclaimer).

## Why don't the numbers match the admin center?

Analytics Hub counts the Purview audit log, not the admin center's data. It also drops test and
evaluation runs, and works in UTC. Hours and value are modelled, not measured. See
[What the data can and can't tell you](METHODOLOGY.md#1-what-the-data-can-and-cant-tell-you) and
[Known limits](METHODOLOGY.md#9-known-limits).

## Which agents does the audit log cover?

- **Covered by default (Audit Standard):** Microsoft 365 Copilot and its agents, Copilot Studio
  agents, Security Copilot, Copilot in Fabric, Cowork.
- **Self-hosted pro-code agents** (Agents SDK, Semantic Kernel, LangChain, etc.): only if
  developers send interactions to Purview (Purview SDK/APIs).
- **Foundry agents:** only when Purview data security is on for the Azure subscription.
- **Third-party AI** (ChatGPT Enterprise, Gemini, Claude): only with Purview pay-as-you-go, logged
  as `AIAppInteraction`.
- **Consumer Copilot** (personal Microsoft accounts): not logged; outside the tenant.
- **What Analytics Hub reads:** `CopilotInteraction` records only, so `AIAppInteraction` activity
  isn't included.

Source: [Audit logs for Copilot and AI applications](https://learn.microsoft.com/en-us/purview/audit-copilot).

## Fabric or Azure?

Both give you the same data, model, measures and app pages. Pick **Fabric** if you have a
capacity (F2 or larger, or a trial). Pick **Azure** if you'd rather not use Fabric. See
[Architecture and costs](ARCHITECTURE.md).

## Installer or by hand?

Use the [installer](INSTALL.md). It's quicker, runs on Fabric or Azure, and repairs and updates
itself. Set it up [by hand](MANUAL-INSTALL.md) only if no install route works for you. By hand is
Fabric only.

## What does it cost?

Analytics Hub is free. You pay for the Fabric capacity, or about $5–40 a month of Azure for a
small tenant. Viewers need Power BI Pro below F64. See
[What it costs](PREREQUISITES.md#what-it-costs) and [Running costs](ARCHITECTURE.md#running-costs).

## Where does the data go, and who can see it?

Into your own Fabric workspace or Azure subscription. Nothing leaves your tenant. Viewers see it
through the **Analytics Hub Viewers** group, not workspace roles. Once it's copied, your Purview
and Microsoft 365 retention policies don't apply to it: managing it is up to you. See
[Viewing Analytics Hub](PERMISSIONS.md#viewing-analytics-hub-paths-1-and-2).

## I used ValueLens. What changes?

Analytics Hub used to live in
[ValueLens for Microsoft Copilot](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot) as
paths 1 (Fabric) and 2 (Azure). Your install keeps working: download the installer from here, open
it and choose **Repair or change**. ValueLens still has the Power BI templates for Power Automate +
Dataverse, SharePoint and local CSV files.

## Why are some things still called ValueLens?

They kept their names so existing installs, reports and links keep working:

- The **ValueLens** Power BI report and its templates, `ValueLens - Fabric.pbit` and
  `ValueLens - Fabric OneLake.pbit`.
- `ValueLens Model`, in installs from earlier versions. New installs name it `Analytics Hub Model`.
- The [report guide (PDF)](ValueLens-Report-Interpretation-Guide.pdf), which explains the
  ValueLens report.
- The install record, `valuelens-install.json`, and the notebooks named `ValueLens_*`.

## My organisation blocks the exe

Use another route: the PowerShell one-liner, an IT-approved Node.js, or Azure Cloud Shell. Don't
work around the policy. See [Install](INSTALL.md).
