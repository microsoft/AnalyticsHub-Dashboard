# Analytics Hub for Microsoft Copilot

See how your organisation uses Microsoft 365 Copilot and agents, and the hours and value they
deliver.

[![Analytics Hub preview](media/AnalyticsHub-Preview.gif)](docs/APP-GUIDE.md)

**Watch first: the app, page by page** *(silent, about 2 minutes, sample data)*

https://github.com/user-attachments/assets/b415625d-c2ae-467f-9a91-59ef9adca6c8

## Getting started

Pick a path. Both load the data and publish the models.

| | [**1. Fabric**](1-fabric/) (recommended) | [**2. Azure**](2-azure/) |
|---|---|---|
| **You need** | A Fabric capacity, F2 or larger, or a [free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager) | An Azure subscription or resource group, and a Power BI workspace |
| **Set up with** | The installer, or by hand | The installer |
| **Takes** | About 20 minutes. The first data arrives about 25 minutes after **Go ahead** | The same as Fabric |
| **Costs** | The Fabric capacity | About $5–40 a month for a small tenant |

<a id="architecture-and-running-costs"></a>
Analytics Hub itself is free. See [Architecture and costs](docs/ARCHITECTURE.md).

<a id="automatic-the-installer"></a><a id="fabric-or-azure"></a>

## Path 1: Fabric

**Installer**

1. Send each admin their row of the [prerequisites](docs/PREREQUISITES.md), Fabric column.
2. [Run the installer](#run-the-installer). Choose **Microsoft Fabric**.
3. [Check it worked](docs/INSTALL.md#check-it-worked). The Done page lists anything left to do, and
   who does it.

<a id="manual-step-by-step"></a>
**By hand** · [🎥 Watch it first](fabric/README.md#set-it-up-by-hand)

1. [Prerequisites](docs/MANUAL-INSTALL.md#1-prerequisites): the Fabric ones, plus an app
   registration, a Lakehouse and Power BI Desktop.
2. [Install](docs/MANUAL-INSTALL.md#2-install): the notebooks, the report and the pipeline. The app
   is optional.
3. [Check it worked](docs/MANUAL-INSTALL.md#3-verify): the pipeline run, the data and the report.

## Path 2: Azure

**Installer**

1. Send each admin their row of the [prerequisites](docs/PREREQUISITES.md), Azure column.
2. [Run the installer](#run-the-installer). Choose **Your Azure subscription**.
3. [Check it worked](docs/INSTALL.md#check-it-worked). The Done page lists anything left to do, and
   who does it.

**By hand:** not supported. [Why](docs/MANUAL-INSTALL.md#azure)

## Run the installer

On Windows 10 or 11, paste this into PowerShell. It needs no admin rights, and opens the steps in
your browser:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
```

Or download the exe and open it:

[![Download the Analytics Hub installer](https://img.shields.io/badge/Download-Analytics%20Hub%20installer-0078D4?style=for-the-badge)](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)

Blocked? Use an [IT-approved Node.js](docs/INSTALL.md#it-approved-nodejs) or
[Azure Cloud Shell](docs/INSTALL.md#locked-down-tenant--azure-cloud-shell), or ask your IT team.
Don't work around the policy. To check a download, see
[Check the download](docs/INSTALL.md#check-the-download). More in [Install](docs/INSTALL.md).

## After setup

[Update or remove](docs/UPDATE.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) ·
[FAQ](docs/FAQ.md) · [Release notes](CHANGELOG.md)

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

<a id="what-you-get"></a><a id="why-its-more-than-the-built-in-reports"></a><a id="what-you-can-do-with-it"></a><a id="optional-add-ons"></a><a id="what-data-is-collected"></a><a id="power-bi-reports"></a><a id="documentation"></a><a id="whats-here"></a><a id="repository-layout"></a><a id="copilot-managed-app-preview"></a>

## Reference

What you get, the data, costs, permissions and every other page: **[docs](docs/README.md)**.

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
