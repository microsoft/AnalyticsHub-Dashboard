# Analytics Hub for Microsoft Copilot

See how your organisation uses Microsoft 365 Copilot and agents, and the hours and value they
deliver. Run it on **Microsoft Fabric** or in **your own Azure subscription**.

[![Analytics Hub preview](media/AnalyticsHub-Preview.gif)](docs/APP-GUIDE.md)

**Watch first: the app, page by page** *(silent, about 2 minutes, sample data)*

https://github.com/user-attachments/assets/b415625d-c2ae-467f-9a91-59ef9adca6c8

> Prefer to download it? [Get the demo video](media/AnalyticsHub-Demo.mp4).

> **Moved from ValueLens.** Analytics Hub used to be paths 1 and 2 of
> [ValueLens for Microsoft Copilot](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot).
> Existing installs keep working: see [I used ValueLens](docs/FAQ.md#i-used-valuelens-what-changes).

## Getting started

Pick a path. Fabric and Azure load the data and publish the models.

| | **Fabric** (recommended) | **Azure** |
|---|---|---|
| **Runs on** | Your Fabric capacity | Your Azure subscription |
| **You need** | A Fabric capacity, F2 or larger, or a [free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager) | An Azure subscription or resource group, and a Power BI workspace |
| **Loads the data** | Yes | Yes |
| **Set up with** | The installer, or by hand | The installer |
| **Takes** | About 20 minutes. The first data arrives about 25 minutes after **Go ahead** | The same as Fabric |
| **Costs** | The Fabric capacity | About $5–40 a month for a small tenant |

<a id="architecture-and-running-costs"></a>
Analytics Hub itself is free. See [Architecture and costs](docs/ARCHITECTURE.md).

<a id="automatic-the-installer"></a>

### Fabric or Azure

1. **Check the prerequisites.** [Prerequisites](docs/PREREQUISITES.md) is one table of who does
   what. Send each admin their row before you start.
2. **Run the installer.** On Windows 10 or 11, paste this into PowerShell. It needs no admin
   rights, and opens the steps in your browser:

   ```powershell
   irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
   ```

   Or download the exe and open it:

   [![Download the Analytics Hub installer](https://img.shields.io/badge/Download-Analytics%20Hub%20installer-0078D4?style=for-the-badge)](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)

   Its first question is where it runs: Fabric or Azure. If your organisation blocks both ways of
   starting it, use an [IT-approved Node.js](docs/INSTALL.md#it-approved-nodejs) or
   [Azure Cloud Shell](docs/INSTALL.md#locked-down-tenant--azure-cloud-shell), or ask your IT team.
   Don't work around the policy. To check a download, see
   [Check the download](docs/INSTALL.md#check-the-download). More in [Install](docs/INSTALL.md).
3. **Check it worked.** The Done page lists anything left to do, and who does it. See
   [Check it worked](docs/INSTALL.md#check-it-worked).

<a id="manual-step-by-step"></a>
**Fabric, by hand.** No installer:
[Prerequisites](docs/MANUAL-INSTALL.md#1-prerequisites) → [Install](docs/MANUAL-INSTALL.md#2-install)
→ [Check it worked](docs/MANUAL-INSTALL.md#3-verify).
**[🎥 Watch the manual setup](fabric/README.md#set-it-up-by-hand)** first.

**Then:** [Update or remove](docs/UPDATE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) ·
[FAQ](docs/FAQ.md) · [Release notes](CHANGELOG.md). These pages are also on the
[wiki](https://github.com/microsoft/AnalyticsHub-Dashboard/wiki).

<a id="why-its-more-than-the-built-in-reports"></a>

## What you get

History, your organisation, agents, value and cost, on top of the official Copilot reports. See
[What it adds](docs/FAQ.md#what-does-it-add-to-the-official-reports).

<a id="what-you-can-do-with-it"></a>
**Pages:** Executive summary · Value · Consumption · Efficiency · Adoption · Leaderboards · Work
patterns · Readiness · Agent Evaluation · Governance · Feedback · Ask · Assumptions · Appendix.
Screenshots and every section: **[App guide](docs/APP-GUIDE.md)**.

<a id="optional-add-ons"></a><a id="what-data-is-collected"></a>
**Data:** read-only, and it stays in your tenant. The audit log, licences and org data are always
on. The rest are optional cards on the installer's **Data sources** screen, or extra steps in
[Manual install](docs/MANUAL-INSTALL.md#2-install). Each source:
[What it collects](docs/ARCHITECTURE.md#what-it-collects). Each table and column:
[Data dictionary](docs/DATA-DICTIONARY.md). Each permission:
[Prerequisites](docs/PREREQUISITES.md#permissions). Which agents the audit log covers:
[FAQ](docs/FAQ.md#which-agents-does-the-audit-log-cover).

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

<a id="reference"></a><a id="power-bi-reports"></a>

## Documentation

| Page | What it covers |
|---|---|
| [Prerequisites](docs/PREREQUISITES.md) · [Permissions](docs/PERMISSIONS.md) | Who does what, each permission and role, and costs |
| [Install](docs/INSTALL.md) | The installer: every way to start it, and checking it worked |
| [Manual install](docs/MANUAL-INSTALL.md) | Fabric, by hand |
| [Update or remove](docs/UPDATE.md) | Keeping it current, and removing it |
| [Troubleshooting](docs/TROUBLESHOOTING.md) · [FAQ](docs/FAQ.md) | Error messages, known issues and short answers |
| [Architecture and costs](docs/ARCHITECTURE.md) | What it collects and creates, and what it costs |
| [App guide](docs/APP-GUIDE.md) | Every page, and the [Power BI reports](docs/APP-GUIDE.md#power-bi-reports) |
| [How the value is calculated](docs/METHODOLOGY.md) · [Data dictionary](docs/DATA-DICTIONARY.md) | The numbers, and every table and column |
| [Guide to the ValueLens Power BI report (PDF)](docs/ValueLens-Report-Interpretation-Guide.pdf) | Reading the main Power BI report, still named ValueLens |
| [Installer reference](installer/README.md) | Every installer option and command |
| [Release notes](CHANGELOG.md) | What changed |

<a id="whats-here"></a><a id="repository-layout"></a>
What each folder holds: [Repository layout](CONTRIBUTING.md#repository-layout).

<a id="copilot-managed-app-preview"></a>
Parked ideas, like the Copilot Managed App, are in [ideas](ideas/README.md). They aren't supported.

## Help

[Open an issue](https://github.com/microsoft/AnalyticsHub-Dashboard/issues) ·
[Support](SUPPORT.md) · [Report a vulnerability](SECURITY.md) · [Contributing](CONTRIBUTING.md) ·
[MIT licence](LICENSE)

To contribute, open a pull request against `main`. Keith reviews and approves every change, and
only Keith creates release tags. See [Contributing](CONTRIBUTING.md#reviews-and-releases).

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
