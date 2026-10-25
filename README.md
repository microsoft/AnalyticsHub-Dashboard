<div align="center">

<br>

# 📊 Analytics Hub for Microsoft Copilot

**See how your organisation uses Microsoft 365 Copilot and agents, and the hours and value they deliver.**

<br>

All reports and guides can be found on the [Analytics Hub site](https://microsoft.github.io/Analytics-Hub/).

**Want a more targeted report?** [ValueLens](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot)
covers the adoption and value parts of Analytics Hub, and
[Consumption Central](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot) covers
credit consumption and cost.

<br>

**Found this useful? ⭐ Star this repo to help others discover it!**

<br>

**[Before you start](#before-you-start)** &nbsp;·&nbsp; **[Installer](#installer)** &nbsp;·&nbsp; **[Manual](#manual)** &nbsp;·&nbsp; **[After setup](#after-setup)**

<br>

</div>

## Videos

[![Analytics Hub preview](media/AnalyticsHub-Preview.gif)](docs/APP-GUIDE.md)

**The app, page by page** *(silent, about 2 minutes, sample data)*

https://github.com/user-attachments/assets/b415625d-c2ae-467f-9a91-59ef9adca6c8

**Manual setup, start to finish:** [watch it](fabric/README.md#set-it-up-by-hand).

<a id="what-you-get"></a>

## What you get

- An app and Power BI reports on Copilot and agent use, value and cost.
- Data from the audit log, licences and your org, loaded every day.
- Everything stays in your own tenant. Analytics Hub itself is free.

<a id="getting-started"></a>

## Before you start

You need:

- [ ] **Somewhere to run it.** A Fabric capacity, F2 or larger, or a
      [free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).
      Or Owner on an Azure subscription or resource group, and a Power BI workspace.
- [ ] **Power BI Pro** for you.
- [ ] **Rights to register an app** in Entra, or an admin who can.
- [ ] **A few minutes from your admins.** Fabric, Entra, Microsoft 365, and Teams on Azure.
      Send each one [their row](docs/PREREQUISITES.md#at-a-glance).
- [ ] **A Windows 10 or 11 PC.** No admin rights needed. Or use Azure Cloud Shell.

<a id="fabric-or-azure"></a><a id="architecture-and-running-costs"></a>

**Fabric or Azure?** Pick [Fabric](1-fabric/) unless you'd rather not use it. [Azure](2-azure/)
costs about $5–40 a month for a small tenant. See [Architecture and costs](docs/ARCHITECTURE.md).

Full list: [Prerequisites](docs/PREREQUISITES.md).

## Choose your path

| Path | Suits |
|---|---|
| **[Installer](#installer)** (recommended, fastest) | Most people. About 20 minutes. It sets everything up and tells you what's left. |
| **[Manual](#manual)** (step by step) | You can't run the installer, or you want to see each piece. Takes longer. |

<a id="automatic-the-installer"></a><a id="run-the-installer"></a>

## Installer

1. Send each admin [their row](docs/PREREQUISITES.md#at-a-glance) of the prerequisites.
2. On your PC, open PowerShell and paste this:

   ```powershell
   irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
   ```

   Or [download the exe](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe) and open it.
3. It opens in your browser. Choose **Set up Analytics Hub** and sign in.
4. Choose **Microsoft Fabric** or **Your Azure subscription**.
5. Answer the questions. It takes about 5 minutes.
6. Check the plan and choose **Go ahead**. Keep the PC awake until it finishes.
7. Read the Done page. It lists anything left to do, and who does it.
   Then [check it worked](docs/INSTALL.md#check-it-worked).

Blocked? Try [Azure Cloud Shell](docs/INSTALL.md#locked-down-tenant--azure-cloud-shell) or an
[IT-approved Node.js](docs/INSTALL.md#it-approved-nodejs). Don't work around your IT policy.
To check the download, see [Check the download](docs/INSTALL.md#check-the-download).
Every option: [Install](docs/INSTALL.md).

<a id="manual-step-by-step"></a>

## Manual

**On Fabric.** [Watch the video](fabric/README.md#set-it-up-by-hand) first.

1. [Get the prerequisites](docs/MANUAL-INSTALL.md#1-prerequisites).
2. [Load the data](fabric/notebooks/README.md) with the notebooks.
3. [Publish the report](fabric/notebooks/README.md#load-the-data) from Power BI Desktop.
4. [Schedule the pipeline](fabric/pipelines/README.md).
5. [Deploy the app](app/README.md#deploy-it-by-hand). Optional.
6. [Check it worked](docs/MANUAL-INSTALL.md#3-verify).

**On Azure.** Follow [seven steps in Azure Cloud Shell](docs/MANUAL-INSTALL.md#azure).

All the detail: [Manual install](docs/MANUAL-INSTALL.md).

## After setup

- **Check it worked.** [Installer](docs/INSTALL.md#check-it-worked) or
  [manual](docs/MANUAL-INSTALL.md#3-verify).
- **Refresh.** The data loads every day. To run it now, or change the schedule, start the
  installer again.
- **Update or remove.** See [Update or remove](docs/UPDATE.md).
- **Get help.** Read [Troubleshooting](docs/TROUBLESHOOTING.md) and the [FAQ](docs/FAQ.md), or
  [open an issue](https://github.com/microsoft/AnalyticsHub-Dashboard/issues).

---

<a id="disclaimer"></a>

<details>
<summary><strong>Disclaimer</strong></summary>

- **This isn't the official Copilot report.** The official sources are the
  [Microsoft 365 admin center Copilot usage reports](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-usage)
  and the [Viva Insights Copilot Dashboard](https://learn.microsoft.com/en-us/viva/insights/org-team-insights/copilot-dashboard).
  Analytics Hub takes its Copilot figures mainly from the Purview audit log, which isn't the
  authoritative source, so its numbers may not always match those reports exactly.
- **You're responsible for the data once it's extracted.** Analytics Hub copies data into your own
  Fabric workspace or Azure subscription. The retention, deletion and other policies you set in
  Purview, Microsoft 365, Entra ID and the other sources don't apply to those copies. Managing that
  data and meeting your organisation's requirements is up to you.
- **Usage and compliance.** Microsoft has no visibility into the data you put in, nor control over
  how the tool is used. You're responsible for making sure your use complies with all applicable
  laws and regulations, including data privacy and security. Microsoft disclaims all liability
  arising from use of this tool.
- **Experimental.** It isn't supported through Microsoft support channels. Please open an issue in
  this repo.

</details>

<a id="reference"></a><a id="why-its-more-than-the-built-in-reports"></a><a id="what-you-can-do-with-it"></a><a id="optional-add-ons"></a><a id="what-data-is-collected"></a><a id="power-bi-reports"></a><a id="documentation"></a><a id="whats-here"></a><a id="repository-layout"></a>

<details>
<summary><strong>Reference</strong></summary>

- [All docs](docs/README.md): the data, permissions, costs and every other page.
- [App guide](docs/APP-GUIDE.md): every page, and the Power BI reports.
- [Installer reference](installer/README.md): every option and command.
- [Release notes](CHANGELOG.md).

</details>

<a id="troubleshooting"></a>

<details>
<summary><strong>Troubleshooting</strong></summary>

- [Troubleshooting](docs/TROUBLESHOOTING.md): error messages and known issues.
- [FAQ](docs/FAQ.md): short answers.
- Something failed in the installer? Start it again and choose **Rerun failed loads**.

</details>

<a id="copilot-managed-app-preview"></a>

<details>
<summary><strong>Archived options</strong></summary>

Parked ideas, like the Copilot Managed App, are in [ideas](ideas/README.md). They aren't
supported.

</details>

<a id="help"></a>

<details>
<summary><strong>Help and contributing</strong></summary>

[Open an issue](https://github.com/microsoft/AnalyticsHub-Dashboard/issues) ·
[Support](SUPPORT.md) · [Report a vulnerability](SECURITY.md) · [Contributing](CONTRIBUTING.md) ·
[MIT licence](LICENSE)

Created by [Keith McGrane](https://github.com/Keithland89).

To contribute, open a pull request against `main`. Keith reviews and approves every change, and
only Keith creates release tags. See [Contributing](CONTRIBUTING.md#reviews-and-releases).

</details>