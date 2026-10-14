# Analytics Hub for Microsoft Copilot

See how your organisation uses Microsoft 365 Copilot and agents, and the hours and value they
deliver. One installer sets it up in your tenant, on Microsoft Fabric or in your own Azure
subscription.

## Which path?

Two paths. Each is the same 3 steps. Not sure? Use **Automatic**.

| | **Automatic** (recommended) | **Manual** |
|---|---|---|
| **How** | The installer sets it up and checks it, about 20 minutes | You follow the steps, no installer |
| **Runs on** | Fabric or Azure | Fabric only |
| **Then** | Repair, update and status from the installer | You update it by hand |

## Automatic (installer)

1. [Prerequisites](../PREREQUISITES.md): who does what, and how long it takes.
2. [Install](../INSTALL.md): the PowerShell one-liner, the exe or Azure Cloud Shell.
3. [Verify](../VERIFY.md): check the first data has arrived.

## Manual (by hand, Fabric)

1. [Prerequisites](../MANUAL-INSTALL.md#1-prerequisites): the same, plus an app registration you
   create.
2. [Install](../MANUAL-INSTALL.md#2-install): notebooks, report, pipeline, then the app.
3. [Verify](../MANUAL-INSTALL.md#3-verify): check the pipeline run, the data and the report.

## Operate

- [Update](../UPDATE.md)
- [Uninstall](../UNINSTALL.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
- [Known issues](../KNOWN-ISSUES.md)
- [FAQ](../FAQ.md)
- [Release notes](../../CHANGELOG.md)

## Reference

- [Architecture and costs](../ARCHITECTURE.md)
- [Permissions](../PERMISSIONS.md)
- [App guide](../APP-GUIDE.md)
- [How the value is calculated](../METHODOLOGY.md)
- [Data dictionary](../DATA-DICTIONARY.md)
- [Installer reference](../../installer/README.md)

These pages are published from the repo's [docs](../) folder. To change one, open a pull request
there.
