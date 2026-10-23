# Path 1: Fabric

Analytics Hub on your Fabric capacity. The recommended path.

## Before you start

- **You need:** a Fabric capacity, F2 or larger, or a
  [free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager).
- **Takes:** about 20 minutes to set up. The first data follows about 25 minutes later with 30 days
  of history, or hours later on a large tenant: see
  [How long it takes](../docs/PREREQUISITES.md#how-long-it-takes).
- **Costs:** the Fabric capacity. Analytics Hub itself is free.

## Installer

1. **Prerequisites.** Send each admin their row of [Prerequisites](../docs/PREREQUISITES.md),
   from the Fabric column.
2. **Run the installer.** On Windows 10 or 11, paste this into PowerShell. It needs no admin
   rights:

   ```powershell
   irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
   ```

   Or [download the exe](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe)
   and open it. Choose **Microsoft Fabric**. Blocked? See the other ways to start it in
   [Install](../docs/INSTALL.md). Don't work around the policy.
3. **Check it worked.** The Done page lists anything left to do, and who does it. See
   [Check it worked](../docs/INSTALL.md#check-it-worked).

## Manual

No installer. [🎥 Watch the manual setup](../fabric/README.md#set-it-up-by-hand) first.

1. [Prerequisites](../docs/MANUAL-INSTALL.md#1-prerequisites): the Fabric ones, plus an app
   registration, a Lakehouse and Power BI Desktop.
2. [Install](../docs/MANUAL-INSTALL.md#2-install): the notebooks, the report and the pipeline. The
   app is optional.
3. [Check it worked](../docs/MANUAL-INSTALL.md#3-verify): the pipeline run, the data and the
   report.

## After setup

[Update or remove](../docs/UPDATE.md) · [Troubleshooting](../docs/TROUBLESHOOTING.md) ·
[FAQ](../docs/FAQ.md)

The details, like where the client secret goes and the optional extras, are in
[fabric](../fabric/README.md).
