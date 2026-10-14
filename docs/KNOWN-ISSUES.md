# Known issues

Limits we know about, and what to do. For error messages, see [Troubleshooting](TROUBLESHOOTING.md).

## Installing

- **The exe and `install.ps1` aren't code-signed yet.** Edge and Windows SmartScreen warn about
  them. See [Check the download](INSTALL.md#check-the-download). Under an `AllSigned` policy, use
  `irm | iex`.
- **AppLocker or WDAC can block both the exe and the PowerShell one-liner.** Use
  [Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell).
- **Cloud Shell can't sign in where Conditional Access blocks sign-in with a code.** Run the
  installer on a PC that's allowed.
- **Cloud Shell ends a session after 20 minutes without input.** Run the same command again: it
  carries on from the install record.
- **Keep the PC awake.** If it sleeps, setup stops until it wakes.

## Fabric

- **A Fabric trial lasts 60 days and can't run the Ask data agent.** Move the workspace to a paid
  capacity before it ends, or its notebooks and pipeline stop.
- **The secret in the notebooks can be read by anyone with a workspace role.** That's the default
  trade-off for needing no Azure. Use a Key Vault to avoid it. See
  [Where the secret goes](../installer/README.md#where-the-secret-goes).
- **`--flow-identity app` needs a Key Vault that allows public network access.** The Key Vault
  connector can't reach a private vault.
- **The Cowork Dataflow fails until someone signs in to it.** That's expected: the load shows it as
  waiting, not failed.

## Azure

- **Some modules aren't on Azure yet:** Agent 365 registry, product feedback, Agent Evaluator,
  GitHub Copilot credits and Cowork credits through the Dataflow.
- **Networking can't be changed in place.** [Uninstall](UNINSTALL.md), then install again.
- **Org-scoped access isn't supported with private networking yet.** Its notebook can't reach the
  storage account. See [Org-scoped access](PERMISSIONS.md#org-scoped-access-row-level-security).
- **Container Apps logs can't be queried from a public network** with private networking, without
  an Azure Monitor Private Link Scope.

## Data

- **Figures may not match the official Copilot reports.** Analytics Hub reads the Purview audit
  log, which isn't the authoritative source. See the [disclaimer](../README.md#disclaimer).
- **Only `CopilotInteraction` audit records are read**, so third-party AI logged as
  `AIAppInteraction` isn't included.
- **Per-user Copilot Studio credits are best effort.** They come from an undocumented API route,
  and the flow only sees environments with credits allocated. Exports, where you add them, win.
- **On a large tenant, audit records that arrive more than 3 days late are missed.** See
  [A large tenant](../installer/README.md#a-large-tenant).
