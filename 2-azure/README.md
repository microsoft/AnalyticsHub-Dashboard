# Path 2: Azure

Analytics Hub in your own Azure subscription, without Fabric.

- **You need:** an Azure subscription or resource group, and a Power BI workspace.
- **Takes:** about 20 minutes. The first data arrives about 25 minutes after **Go ahead**.
- **Costs:** about $5–40 a month for a small tenant. Analytics Hub itself is free. See
  [Architecture and costs](../docs/ARCHITECTURE.md). For more than 10,000 people, see
  [A large tenant on Azure](../installer/README.md#a-large-tenant-on-azure).

## Installer

1. **Prerequisites.** Send each admin their row of [Prerequisites](../docs/PREREQUISITES.md),
   from the Azure column. If your Azure admin would rather not give you Owner, they can prepare a
   resource group with just the rights the installer needs: see
   [Least-privilege Azure install](../docs/AZURE-LEAST-PRIVILEGE.md).
2. **Run the installer.** On Windows 10 or 11, paste this into PowerShell. It needs no admin
   rights:

   ```powershell
   irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
   ```

   Or [download the exe](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)
   and open it. Choose **Your Azure subscription**, say about how many people work in your
   organisation, then the subscription, resource group, region and Power BI workspace. Blocked? See
   the other ways to start it in [Install](../docs/INSTALL.md). Don't work around the policy.
3. **Check it worked.** The Done page lists anything left to do, and who does it. See
   [Check it worked](../docs/INSTALL.md#check-it-worked).

## By hand

No installer: [seven steps in Azure Cloud Shell](../docs/MANUAL-INSTALL.md#azure), from the
installer's own template and report. They need a release that includes them: **Get the files**
checks for one. Or run the installer itself in
[Azure Cloud Shell](../docs/INSTALL.md#locked-down-tenant--azure-cloud-shell).

## Then

[Update or remove](../docs/UPDATE.md) · [Troubleshooting](../docs/TROUBLESHOOTING.md) ·
[FAQ](../docs/FAQ.md)

The details, like sharing, credit consumption and private networking, are in
[azure](../azure/README.md).
