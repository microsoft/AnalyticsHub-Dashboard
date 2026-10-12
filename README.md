# Analytics Hub for Microsoft Copilot

An app that shows how your organisation uses Microsoft 365 Copilot and agents, and the hours and
value they deliver. One installer sets it up in your tenant, on **Microsoft Fabric** or in **your
own Azure subscription**.

[![Analytics Hub preview](media/AnalyticsHub-Preview.gif)](docs/APP-GUIDE.md)

**Watch first: the app, page by page** *(silent, about 2 minutes, sample data)*

https://github.com/user-attachments/assets/b415625d-c2ae-467f-9a91-59ef9adca6c8

> Prefer to download it? [Get the demo video](media/AnalyticsHub-Demo.mp4).

[![Download the Analytics Hub installer](https://img.shields.io/badge/Download-Analytics%20Hub%20installer-0078D4?style=for-the-badge)](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)

For Windows 10 or 11. Open it and follow the steps in your browser. If Edge or Windows warns about
the download, see [Check the download](installer/README.md#check-the-download).

**Before you start**, go through the **[checklist](docs/PREREQUISITES.md)**. It says what you need
and what to ask other admins for (a Fabric admin, an Entra admin and, for some extras, a Power
Platform admin or a Viva Insights analyst), with the costs. Allow about 5 minutes of questions and
15 minutes of setup. The first data arrives about 25 minutes after you approve the plan, or about
2 hours with 180 days of history. No Fabric capacity?
[Start a free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).

> **Moved from ValueLens.** Analytics Hub used to live in
> [ValueLens for Microsoft Copilot](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot)
> as paths 1 (Fabric) and 2 (Azure). Installs from there keep working: download the installer from
> here, open it and choose **Repair or change**. ValueLens still has the Power BI templates for
> Power Automate + Dataverse, SharePoint and local CSV files.

## Disclaimer

- **This isn't the official Copilot report.** The official sources are the
  [Microsoft 365 admin center Copilot usage reports](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-usage)
  and the [Viva Insights Copilot Dashboard](https://learn.microsoft.com/en-us/viva/insights/org-team-insights/copilot-dashboard).
  Analytics Hub takes its Copilot figures mainly from the Purview audit log, which isn't the
  authoritative source, so its numbers may not always match those reports exactly.
- **You're responsible for the data once it's extracted.** Analytics Hub copies data into your own
  Fabric workspace or Azure subscription. The retention, deletion and other policies you set in
  Purview, Microsoft 365, Entra ID and the other sources don't apply to those copies. Managing that
  data and meeting your organisation's requirements is up to you.

## What each page answers

| Page | Answers | Data from |
|---|---|---|
| **Executive summary** | What is Copilot delivering, and where? | All of the below, in one page |
| **Adoption** | Who started, who stayed, who stuck? | Purview audit log, licences, org data |
| **Leaderboards** | Which people and agents do the most? | Audit log, Agent 365 registry |
| **Work patterns** | Where does Copilot fit in everyday Microsoft 365 work? | Microsoft 365 usage reports *(optional)* |
| **Agent Evaluation** | How well do our agents answer? | Copilot Studio transcripts *(Agent Evaluator add-on)* |
| **Governance** | Who owns our agents, who can reach them, what needs a review? | Agent 365 registry, Azure Resource Graph, Defender *(optional)* |
| **Readiness** | Who should get a licence next, and who is ready for Cowork? | Audit log, licences |
| **Consumption** | What credits did we use, and what did they cost? | Copilot credits, Azure cost *(Credit consumption add-on)* |
| **Value** | What was the work, and what was it worth? | Audit log, time per task |
| **Efficiency** | Is the right tool doing the job? | Audit log |
| **Feedback** | What do people say about it? | Product feedback export *(optional)* |
| **Assumptions** · **Appendix** | How long does each task take? What does each metric mean? | The model's task times and glossary |

Screenshots and every section, page by page: **[App guide](docs/APP-GUIDE.md)**.

## Pick where it runs

Both give you the same data, model, measures and app pages.

| Where | You need | Setup |
|---|---|---|
| **[Fabric](fabric/)** (recommended) | Fabric capacity (F2 or larger, or a [free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager)) | Open the installer. It sets up everything and deploys the dashboard as an app in Fabric. To set it up by hand instead, **[🎥 watch the manual setup](fabric/README.md#set-it-up-by-hand)**. |
| **[Azure](azure/)** | An Azure subscription (Contributor plus User Access Administrator) and Power BI Pro | Open the installer and pick **Your Azure subscription**. It deploys Azure SQL, Container Apps jobs and the web app, with no Fabric. See [Azure target](installer/README.md#azure-target). |

**Update an existing install:** download the latest installer, open it and choose **Repair or
change**. Your saved answers are kept.

## Optional add-ons

- **Credit consumption and cost:** on the installer's **Data sources** screen, choose any of the
  **Copilot Studio credits**, **Copilot Cowork credits** and **Azure AI costs** cards, or
  [set it up by hand](fabric/Add%20Credit%20Consumption/) in Fabric.
- **Copilot Studio agent conversations:** in Fabric, choose *Agent Evaluator* in the installer, or
  [set it up by hand](fabric/Add%20Agent%20Evaluator/).
- **Shadow AI and agent risk:** in Fabric or Azure, choose *Defender (shadow AI and agent risk)* in
  the installer. It reads Microsoft Defender, needs Defender for Endpoint P2 or Defender for Cloud
  Apps, and fills the Shadow AI section of the app's Governance page
  ([details](installer/README.md#defender-shadow-ai-and-agent-risk)).

## Power BI reports

The installer also publishes Power BI reports on the same models as the app, for anyone who prefers
Power BI or wants to build their own ([details](installer/README.md#power-bi-reports)).

| ValueLens | Consumption Central | Agent Evaluator |
|---|---|---|
| [![ValueLens report](media/powerbi/valuelens.png)](media/powerbi/valuelens.png) | [![Consumption Central report](media/powerbi/consumption-central.png)](media/powerbi/consumption-central.png) | [![Agent Evaluator report](media/powerbi/agent-evaluator.png)](media/powerbi/agent-evaluator.png) |
| Adoption, value and governance. The app's main model. | Credits and cost. The *Credit consumption* add-on. | Copilot Studio agent quality. The *Agent Evaluator* add-on. |

## What's here

| Folder | What it is |
|---|---|
| [`installer/`](installer/) | `AnalyticsHubInstaller.exe`: sets up, repairs and updates Fabric or Azure installs |
| [`app/`](app/) | The Analytics Hub app: a Fabric app item, and the web app's front end on Azure |
| [`fabric/`](fabric/) | Notebooks, pipeline, flows and Power BI models the installer deploys to Fabric, and how to set them up by hand |
| [`azure/`](azure/) | Bicep, Container Apps jobs, SQL schema, web app and Teams package for the Azure target |
| [`core/`](core/) | `valuelens_core`, the Python core shared by the Azure jobs and the Fabric Defender notebook |
| [`samples/`](samples/) | Synthetic sample data for demo mode |
| [`docs/`](docs/) | App guide, methodology, prerequisites, permissions and data dictionary |
| [`media/`](media/) | Screenshots and the demo video |

## Reference

- [App guide](docs/APP-GUIDE.md)
- [How the value is calculated](docs/METHODOLOGY.md)
- [Before you start](docs/PREREQUISITES.md)
- [Permissions](docs/PERMISSIONS.md)
- [Data dictionary](docs/DATA-DICTIONARY.md)
- [Power BI report guide (PDF)](docs/ValueLens-Report-Interpretation-Guide.pdf)
- [Installer reference](installer/README.md)
- [What changed](CHANGELOG.md)

<details>
<summary>Which agents does the audit log cover?</summary>

- **Covered by default (Audit Standard):** Microsoft 365 Copilot and its agents, Copilot Studio agents, Security Copilot, Copilot in Fabric, Cowork.
- **Self-hosted pro-code agents** (Agents SDK, Semantic Kernel, LangChain, etc.): only if developers send interactions to Purview (Purview SDK/APIs).
- **Foundry agents:** only when Purview data security is on for the Azure subscription.
- **Third-party AI** (ChatGPT Enterprise, Gemini, Claude): only with Purview pay-as-you-go, logged as `AIAppInteraction`.
- **Consumer Copilot** (personal Microsoft accounts): not logged; outside the tenant.
- **What Analytics Hub reads:** `CopilotInteraction` records only, so `AIAppInteraction` activity isn't included.

Source: [Audit logs for Copilot and AI applications](https://learn.microsoft.com/en-us/purview/audit-copilot)
</details>

## Help

[Open an issue](https://github.com/microsoft/AnalyticsHub-Dashboard/issues) ·
[Support](SUPPORT.md) · [Report a vulnerability](SECURITY.md) · [Contributing](CONTRIBUTING.md) ·
[MIT licence](LICENSE)

<details>
<summary>Usage and compliance disclaimer</summary>

While this tool helps customers understand the business value of their AI usage data, Microsoft has
**no visibility** into the data customers input, nor control over how the tool is used. Customers
are solely responsible for ensuring their use complies with all applicable laws and regulations
(including data privacy and security). **Microsoft disclaims all liability** arising from use of this
tool.

This is an **experimental** tool with Purview audit logs as the primary source. Audit logs
provide visibility into Copilot/agent interactions but are not intended as the sole source of truth
for licensing or full‑fidelity reporting. Not supported through Microsoft support channels — please
open an issue in this repo.
</details>