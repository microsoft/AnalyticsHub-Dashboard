# Known issues

Limits we know about, and what to do. For error messages, see [Troubleshooting](TROUBLESHOOTING.md).

## Installing

- **The exe and `install.ps1` aren't code-signed yet.** A matching SHA-256 confirms a file is the
  one in the release, not who published it. See [Check the download](INSTALL.md#check-the-download).
  If your organisation's policy blocks them, use another route in [Install](INSTALL.md) or ask
  your IT team.
- **AppLocker or WDAC can block both the exe and the PowerShell one-liner.** Use
  [IT-approved Node.js](INSTALL.md#it-approved-nodejs) if your IT team has approved one, or
  [Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell).
- **The Windows management command can lose non-ASCII paths.** `analytics-hub.cmd` is written as
  ASCII. A non-ASCII installed Node.js path or Documents path can break later uses of that command,
  even when the initial PowerShell launch works. Re-run the original approved launch command,
  where policy permits, or ask your IT team. Unicode command generation remains a follow-up to #77.
- **Cloud Shell can't sign in where Conditional Access blocks sign-in with a code.** Run the
  installer on a PC that's allowed.
- **Cloud Shell ends a session after 20 minutes without input.** Run the same command again: it
  carries on from the install record.
- **Keep the PC awake.** If it sleeps, setup stops until it wakes.
- **Run it from a desktop session: at the PC, or over Remote Desktop.** Without one, for example
  over SSH, the app's deploy tool may not be able to store its sign-in securely. A Fabric install
  then sets up everything except the app. To finish, run `deploy-app` from a desktop session. See
  [Troubleshooting](TROUBLESHOOTING.md#the-app-reports-and-data).

## Unsigned files in the download

`AnalyticsHubInstaller.zip` (which the exe and `install.ps1` unpack) holds a signed `node.exe` and
these unsigned native files, all in Rayfin's packages under `f\app\node_modules`:

| File | Why it's there | When it loads |
|---|---|---|
| `@azure\msal-node-extensions\bin\x64\dpapi.node` | Encrypts Rayfin's saved sign-in with Windows DPAPI | When Rayfin signs you in itself to deploy the app on a Fabric install |
| `keytar\build\Release\keytar.node` | msal-node-extensions loads it with the DPAPI cache; Rayfin stops if it can't | Same as above |

Neither loads on an Azure install, or when the installer hands Rayfin its own sign-in (in Cloud
Shell, or when Rayfin is signed in as someone else). If policy blocks native files under your
profile, use [Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell) or ask your IT
team. The zip also has `dpapi.node` for arm64 and ia32, which never load on x64.

The download no longer includes esbuild's `esbuild.exe`, `tsx`, or msal-node-runtime's native
sign-in broker: nothing loads them when the installer runs.

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
