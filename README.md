# Analytics Hub for Microsoft Copilot

An app that shows how your organisation uses Microsoft 365 Copilot and agents, and the hours and
value they deliver. One installer sets it up in your tenant, on **Microsoft Fabric** or in **your
own Azure subscription**.

[![Download the Analytics Hub installer](https://img.shields.io/badge/Download-Analytics%20Hub%20installer-0078D4?style=for-the-badge)](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)

For Windows 10 or 11. Open it and follow the steps in your browser. Check
[what you need](docs/PREREQUISITES.md) first. If Edge or Windows warns about the download, see
[Check the download](installer/README.md#check-the-download).

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

## Pick where it runs

Both give you the same data, model, measures and app pages.

| Where | You need | Setup |
|---|---|---|
| **[Fabric](fabric/)** (recommended) | Fabric capacity (F2 or larger, or a trial) | Open the installer. It sets up everything and deploys the dashboard as an app in Fabric. **[🎥 Watch the setup](fabric/README.md#for-manual-setup-not-using-the-installer)** |
| **[Azure](azure/)** (preview) | An Azure subscription (Contributor plus User Access Administrator) and Power BI Pro | Open the installer and pick **Your Azure subscription**. It deploys Azure SQL, Container Apps jobs and the web app, with no Fabric. See [Azure target](installer/README.md#azure-target-preview). |

**Update an existing install:** download the latest installer, open it and choose **Repair or
change**. Your saved answers are kept.

## Optional add-ons

- **Credit consumption and cost:** choose it in the installer, or
  [set it up by hand](fabric/Add%20Credit%20Consumption/) in Fabric.
- **Copilot Studio agent conversations:** in Fabric, choose *Agent Evaluator* in the installer, or
  [set it up by hand](fabric/Add%20Agent%20Evaluator/).
- **Shadow AI and agent risk:** in Fabric or Azure, choose *Defender (shadow AI and agent risk)* in
  the installer. It reads Microsoft Defender, needs Defender for Endpoint P2 or Defender for Cloud
  Apps, and fills the Shadow AI section of the app's Governance page
  ([details](installer/README.md#defender-shadow-ai-and-agent-risk)).

## What's here

| Folder | What it is |
|---|---|
| [`installer/`](installer/) | `AnalyticsHubInstaller.exe`: sets up, repairs and updates Fabric or Azure installs |
| [`app/`](app/) | The Analytics Hub app: a Fabric app item, and the web app's front end on Azure |
| [`fabric/`](fabric/) | Notebooks, pipeline, flows and Power BI models the installer deploys to Fabric, and how to set them up by hand |
| [`azure/`](azure/) | Bicep, Container Apps jobs, SQL schema, web app and Teams package for the Azure target |
| [`core/`](core/) | `valuelens_core`, the Python core shared by the Azure jobs and the Fabric Defender notebook |
| [`samples/`](samples/) | Synthetic sample data for demo mode |
| [`docs/`](docs/) | Methodology, prerequisites, permissions and data dictionary |

## Reference

- [How the value is calculated](docs/METHODOLOGY.md)
- [Prerequisites](docs/PREREQUISITES.md)
- [Permissions](docs/PERMISSIONS.md)
- [Data dictionary](docs/DATA-DICTIONARY.md)
- [Report interpretation guide (PDF)](docs/ValueLens-Report-Interpretation-Guide.pdf)
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