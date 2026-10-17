# Analytics Hub for Microsoft Copilot

See how your organisation uses Microsoft 365 Copilot and agents, and the hours and value they
deliver. Run it on Microsoft Fabric, in your own Azure subscription, or as a Copilot Managed App
(preview).

## Which path?

Not sure? Use **Fabric**, with the installer.

| | **Fabric** (recommended) | **Azure** | **Copilot Managed App** (preview) |
|---|---|---|---|
| **Runs on** | Your Fabric capacity | Your Azure subscription | The Copilot Managed Runtime, hosted by Microsoft |
| **Set up with** | The installer, or by hand | The installer | Microsoft's `ms` command line |
| **Loads the data** | Yes | Yes | No: it reads the Fabric or Azure models |

## Fabric or Azure (installer)

1. [Prerequisites](../PREREQUISITES.md): who does what, and how long it takes.
2. [Install](../INSTALL.md): the PowerShell one-liner, the exe or Azure Cloud Shell.
3. [Check it worked](../INSTALL.md#check-it-worked): the first data, and what's left to do.

## Fabric by hand

1. [Prerequisites](../MANUAL-INSTALL.md#1-prerequisites): the same, plus an app registration you
   create.
2. [Install](../MANUAL-INSTALL.md#2-install): notebooks, report, pipeline, then the app.
3. [Check it worked](../MANUAL-INSTALL.md#3-verify): the pipeline run, the data and the report.

## Copilot Managed App (preview)

1. Set up Fabric or Azure first. The app reads the models they publish.
2. [Before you start](../MANAGED-APP.md#before-you-start): the settings your admins turn on.
3. [Steps](../MANAGED-APP.md#steps): deploy it with the `ms` command line, then share it.

## Operate

- [Update or remove](../UPDATE.md)
- [Troubleshooting](../TROUBLESHOOTING.md), including known issues
- [FAQ](../FAQ.md)
- [Release notes](../../CHANGELOG.md)

## Reference

- [Architecture and costs](../ARCHITECTURE.md)
- [Permissions](../PERMISSIONS.md)
- [App guide](../APP-GUIDE.md)
- [How the value is calculated](../METHODOLOGY.md)
- [Data dictionary](../DATA-DICTIONARY.md)
- [Running the Viva Insights query](../VIVA-QUERY.md), for Copilot Cowork credits
- [Installer reference](../../installer/README.md)

These pages are published from the repo's [docs](../) folder. To change one, open a pull request
there.
