# Prerequisites

The installer checks what it can before making changes and tells you what is missing. Choose
[Fabric](../1-fabric/) or [Azure](../2-azure/), then ask only the admins you need. For manual
setup, see the additional [requirements](MANUAL-INSTALL.md#1-prerequisites).

## At a glance

| Setup | You need |
|---|---|
| Both | Power BI Pro or Premium Per User (PPU), and permission to register an app in Microsoft Entra ID. |
| Fabric | An F2-or-larger capacity or [free trial](https://learn.microsoft.com/fabric/fundamentals/fabric-trial#method-1-start-a-new-trial-capacity-from-the-account-manager), plus Contributor access to the capacity or Admin/Member access to the workspace. |
| Azure | A subscription or resource group, a Power BI workspace you can create or use, and Owner access, or Contributor plus User Access Administrator on that scope. See the [least-privilege option](AZURE-LEAST-PRIVILEGE.md). |

You can run the installer on Windows 10 or 11, in [Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell),
or with [Node.js on another system](INSTALL.md#without-the-exe). No PC administrator rights are needed.
If you cannot register an app, an admin can do it for you using the
[admin pack](../installer/README.md#if-you-cant-register-apps).

## Admin checklist

### Fabric admin: about 5 minutes

Turn on **Users can create Fabric items** for the installer, and enable the tenant settings the
setup needs: **Service principals can call Fabric public APIs**, **Semantic Model Execute Queries
REST API**, **Allow visuals created using the Power BI SDK**, and **Fabric App items**. These can
be limited to the relevant users or security groups. The installer checks settings when you are a
Fabric admin. See [Fabric tenant settings](https://learn.microsoft.com/fabric/admin/fabric-switch).

On Fabric, the app secret is stored in the notebooks by default, where anyone with a workspace
role can read it. Choose a [Key Vault](../installer/README.md#where-the-secret-goes) if that
access is too broad.

### Azure roles

The Azure role in the table above lets the installer deploy resources and assign the roles it
needs. If your admin prefers not to grant it at subscription or resource-group scope, they can
prepare a resource group with constrained access using the
[least-privilege guide](AZURE-LEAST-PRIVILEGE.md).

### Entra admin

A Global Administrator or Privileged Role Administrator must grant admin consent for the
application permissions. On Azure, consent is needed for both the app and its managed identity.
Core data collection uses read-only permissions; sharing and optional data sources may request
additional permissions. Review the [permissions list](PERMISSIONS.md) before granting consent.

### Compliance admin

Make sure Microsoft Purview audit logging is on; it usually is by default. New audit records can
take 60 minutes to 24 hours to appear. See [Microsoft's audit logging guide](https://learn.microsoft.com/purview/audit-log-enable-disable).

### Microsoft 365 admin

If you want names to appear in Microsoft 365 activity reports, turn off **Display concealed user,
group, and site names in all reports** in the Microsoft 365 admin center. See
[Microsoft's guide](https://learn.microsoft.com/troubleshoot/microsoft-365/admin/miscellaneous/reports-show-anonymous-user-name).

### People who view the app

Viewers need Power BI Pro or PPU unless the workspace is on an [F64-or-larger capacity](https://learn.microsoft.com/fabric/enterprise/licenses#per-user-or-individual-licenses),
and membership in the **Analytics Hub Viewers** group.

## Optional extras

Only arrange extra access for features you choose. The installer explains what each one needs;
see [optional data sources](../installer/README.md#data-sources-and-exports).

<a id="power-platform-admin-for-the-copilot-studio-credits-flow"></a>

**Copilot Studio credits** need a Power Platform environment, a compatible data policy, a
Power Automate Premium license, and a one-time sign-in by a Power Platform Administrator, Billing
Administrator, or Global Administrator. See the
[detailed checklist](../installer/README.md#credit-consumption).

## Send this to your Viva Insights analyst first

For Copilot Cowork credits, a Viva Insights analyst needs to create an auto-refreshing consumption
query and send you its IDs. See [the setup steps](VIVA-QUERY.md).

## Permissions

Core Graph permissions require admin consent and are read-only. Optional sources and viewer
sharing can request additional access. See the full [roles and permissions](PERMISSIONS.md).

## How long it takes

Allow about 20 minutes for setup. The first audit-history load can take longer, depending on the
source and history selected. See [first-load estimates](../installer/README.md#how-long-the-first-load-takes).

## What it costs

The app is free; your organisation pays for the Fabric capacity or Azure resources it uses.
Viewers may also need Power BI licenses. See [running costs](ARCHITECTURE.md#running-costs).
