# Reference

Everything that isn't a setup step. To set Analytics Hub up, start at the
[README](../README.md#getting-started).

## What you get

History, your organisation, agents, value and cost, on top of the official Copilot reports. See
[What it adds](FAQ.md#what-does-it-add-to-the-official-reports).

**Pages:** Executive summary · Adoption · Value · Consumption · Efficiency · Leaderboards · Work
patterns · Readiness · Agent Evaluation · Governance · Feedback · Ask · Assumptions · Appendix.
Screenshots and every section: **[App guide](APP-GUIDE.md)**.

**Demo video:** the app, page by page.
[Watch it](https://github.com/user-attachments/assets/b415625d-c2ae-467f-9a91-59ef9adca6c8) or
[download it](../media/AnalyticsHub-Demo.mp4).

## The data

Read-only, and it stays in your tenant. The audit log, licences and org data are always on. The
rest are optional cards on the installer's **Data sources** screen, or extra steps in
[Manual install](MANUAL-INSTALL.md#2-install). Each source:
[What it collects](ARCHITECTURE.md#what-it-collects). Each table and column:
[Data dictionary](DATA-DICTIONARY.md). Each permission:
[Prerequisites](PREREQUISITES.md#permissions). Which agents the audit log covers:
[FAQ](FAQ.md#which-agents-does-the-audit-log-cover).

## All docs

| Page | What it covers |
|---|---|
| [Prerequisites](PREREQUISITES.md) · [Permissions](PERMISSIONS.md) | Who does what, each permission and role, and costs |
| [Install](INSTALL.md) | The installer: every way to start it, and checking it worked |
| [Manual install](MANUAL-INSTALL.md) | Fabric, by hand |
| [Update or remove](UPDATE.md) | Keeping it current, and removing it |
| [Troubleshooting](TROUBLESHOOTING.md) · [FAQ](FAQ.md) | Error messages, known issues and short answers |
| [Architecture and costs](ARCHITECTURE.md) | What it collects and creates, and what it costs |
| [App guide](APP-GUIDE.md) | Every page, and the [Power BI reports](APP-GUIDE.md#power-bi-reports) |
| [How the value is calculated](METHODOLOGY.md) · [Data dictionary](DATA-DICTIONARY.md) | The numbers, and every table and column |
| [Model slimming](MODEL-SLIMMING.md) | What changed in the main model for a large tenant, and the order to deploy it |
| [Running the Viva Insights query](VIVA-QUERY.md) | For Copilot Cowork credits |
| [Guide to the ValueLens Power BI report (PDF)](ValueLens-Report-Interpretation-Guide.pdf) | Reading the main Power BI report, still named ValueLens |
| [Installer reference](../installer/README.md) | Every installer option and command |
| [Release notes](../CHANGELOG.md) | What changed |

The pages in this folder are also on the [wiki](https://github.com/microsoft/AnalyticsHub-Dashboard/wiki).

## More

- **Moved from ValueLens.** Analytics Hub used to be paths 1 and 2 of
  [ValueLens for Microsoft Copilot](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot).
  Existing installs keep working: see [I used ValueLens](FAQ.md#i-used-valuelens-what-changes).
- What each folder holds: [Repository layout](../CONTRIBUTING.md#repository-layout).
- Parked ideas, like the Copilot Managed App, are in [ideas](../ideas/README.md). They aren't
  supported.
