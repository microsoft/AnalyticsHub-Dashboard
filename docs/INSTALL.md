# Install

Check the [Prerequisites](PREREQUISITES.md) first. Then start the installer one of these ways.
They all run the same installer and ask the same questions.

| Your PC | Start with |
|---|---|
| Windows 10 or 11 | [The exe](#run-it) |
| Windows, but downloaded exes are blocked | [The PowerShell one-liner](#from-powershell) |
| Locked down, or not Windows | [Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell) |
| A clone of this repo, with Node.js | [Without the exe](#without-the-exe) |

**Fabric or Azure.** The first question is where it runs: **Your Fabric capacity** or **Your Azure
subscription** (`--target azure`). The steps are the same. On Azure, you pick a subscription,
resource group, region and Power BI workspace instead of a capacity, workspace and secret. Only
regions that pass the [region preflight](../installer/README.md#regions-and-images) are offered.
For [private networking](../installer/README.md#networking), choose **Yes** for the advanced
settings. More in [Azure target](../installer/README.md#azure-target).

Next: [Verify the install](VERIFY.md).

## Run it

1. [Download the installer](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/AnalyticsHubInstaller.exe).
   This link always gets the newest version. If Edge says it isn't commonly downloaded, choose
   **…** next to the file, then **Keep**, **Show more** and **Keep anyway**. To check the file,
   see [Check the download](#check-the-download). If your organisation blocks downloaded exes,
   use the [PowerShell command](#from-powershell) instead and carry on from step 3. If your PC
   can't run either, use [Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell).
2. Open it. If Windows says it protected your PC, choose **More info**, then **Run anyway**.
3. The first time, it takes about a minute to unpack. Then it opens in your browser. Keep its
   window open while you use the page, and keep the PC awake and plugged in until it finishes. If
   you close the page, go back to that window and press **Enter** to open it again.
4. Choose **Set up Analytics Hub** and sign in.
5. Answer the questions. This takes about 5 minutes:
   1. **Data sources.** Each source has a card: **Connected (API)**, **Upload CSV** or **Skip**.
      Copilot usage, licences and org data are always connected. Microsoft 365 activity is
      connected by default; the rest are skipped until you choose otherwise. The **Copilot Studio
      credits**, **Copilot Cowork credits** and **Azure AI costs** cards make up
      [Credit consumption](../installer/README.md#credit-consumption). A CSV card says
      where to export the file, and you can pick the exports to upload now. A source that needs
      more to work asks for it next, such as the Power Platform environment for a flow. See
      [Data sources and exports](../installer/README.md#data-sources-and-exports).
   2. **Change the advanced settings?** **No** (the default) takes the defaults that suit most
      organisations. See [Advanced settings](../installer/README.md#advanced-settings).
   3. **Capacity and workspace.** A new workspace is named `Analytics Hub` and its Lakehouse
      `Analytics_Hub`, or the next free name. F64 or larger is recommended for more than 10,000
      people. An existing install keeps its names. On Azure: the subscription, resource group,
      region and Power BI workspace.
   4. **App registration:** create one, use your own (it's checked first), or let an admin
      register it. See [If you can't register apps](../installer/README.md#if-you-cant-register-apps).
   5. **Where the secret goes** (Fabric only): in the notebooks by default, with nothing in Azure.
      Or a Key Vault you create or pick; if you can't write to it, a vault admin can add the
      secret. See [Where the secret goes](../installer/README.md#where-the-secret-goes).
6. Check the plan and approve it. Nothing is created until you do. The plan shows every setting,
   including the defaults, and a **Costs** list of what's billed (the Fabric capacity, Power
   Automate Premium for the flows, the Azure resources), with links to the pricing pages. The exe
   stops Windows going to sleep while it runs.
7. Wait for it to finish. Setting up takes about 15 minutes. The first data reaches the app about
   25 minutes after you choose **Go ahead** with 30 days of history, or about 2 hours with 180 days
   ([a large tenant](../installer/README.md#a-large-tenant) takes longer). Copilot Studio credits arrive after the Studio
   flow's first run: see [Load the Studio credits now](../installer/README.md#power-automate-flows).
8. When it finishes, open the link to the app.

**Want to change an answer?** Choose **Back**, on any question or on the plan. It opens the
previous question with your answer filled in, and the questions after it are asked again. If you
go back to the client secret, leave the box empty to keep the one you pasted. If you go back
further, you'll be asked for it again.

It keeps your answers in `Documents\Analytics Hub`, in an install record named
`valuelens-install.json`. Keep that folder. To run the pipeline, check status, update, or repair
the set-up later, open the exe again. **Manage Analytics Hub** shows the record's full path. If
OneDrive syncs your Documents folder, the record follows you to your other PCs.

**The workspace has gone?** After you sign in, the installer checks that the record's workspace
still exists. If Fabric says it doesn't, or the record is for another tenant, the home page says
so. Choose **Start fresh** to set up again. The old record is kept beside the new one, renamed
with the date and time, such as `valuelens-install.20260507-090302.json`. Or choose **Keep this
record** to carry on with it. In the terminal, `install` asks whether to start fresh. If Fabric
can't be reached, or you can't read the workspace, nothing changes.

**Updates.** See [Update](UPDATE.md).

**Using a workspace that already has things in it?** The installer never changes anything it
didn't create. If one of its names is taken, its own item gets the next free name, such as
`AnalyticsHub_Pipeline_2` or `Analytics Hub 2`. The plan shows the names before you approve it.

**Item names.** A new install names its items after Analytics Hub: `Analytics Hub Model`,
`AnalyticsHub_Pipeline`, the `Analytics Hub SQL …` connection and the `Analytics Hub Data Collector`
app registration. An install from an earlier version keeps the names it already has, such as
`ValueLens Model`.

## Check the download

Each [release](https://github.com/microsoft/AnalyticsHub-Dashboard/releases) lists the
exe's SHA-256, which is also in `AnalyticsHubInstaller.exe.sha256`. To check your copy, run this in
PowerShell, in the folder you downloaded it to:

```powershell
(Get-FileHash .\AnalyticsHubInstaller.exe -Algorithm SHA256).Hash
```

It should match, ignoring capitals. If it doesn't, delete the file and download it again.

Edge and Windows SmartScreen warn about the exe because it's new and isn't code-signed yet:

- If Edge says it **isn't commonly downloaded**, choose **…** next to the file, then **Keep**,
  **Show more** and **Keep anyway**.
- If Windows says it **protected your PC**, choose **More info**, then **Run anyway**.

If your organisation blocks the download or won't let you past the warnings, use the
[PowerShell command](#from-powershell), or [run the installer with Node.js](#without-the-exe).

## From PowerShell

If your organisation blocks downloaded exes, paste this into PowerShell (Windows PowerShell 5.1 or
PowerShell 7) instead. It runs the same installer as the exe, with the same browser steps:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
```

It downloads `AnalyticsHubInstaller.zip` from the latest release (about 120 MB: Node.js, the
installer and the app, already built), checks its SHA-256 against the one written into
`install.ps1`, unpacks it under `%LOCALAPPDATA%\AnalyticsHub` and opens the installer in your
browser. It needs no admin rights, installs nothing system-wide and changes no settings. Run it
again to pick up a new version; it removes the old one.

- **Later commands.** It leaves a command behind for the version it unpacked, for example
  `& $env:LOCALAPPDATA\AnalyticsHub\analytics-hub.cmd status`. With no arguments it opens the
  browser steps.
- **A fixed version.** Each release's notes give a command pinned to that release, such as
  `irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/download/installer-v0.6.1/install.ps1 | iex`.
  A pre-release is only reachable this way: `releases/latest` skips pre-releases.
- **If `irm | iex` is blocked**, download `install.ps1` and `AnalyticsHubInstaller.zip` from the
  [release](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest) and run:

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -ZipPath .\AnalyticsHubInstaller.zip
  ```

  Anything after the options goes to the installer, for example `... -ZipPath .\AnalyticsHubInstaller.zip status`.
  `-ExecutionPolicy Bypass` applies to that one command only. `install.ps1` isn't signed yet, so
  under an `AllSigned` policy use `irm | iex`, which execution policy doesn't cover.
- **Behind a proxy.** It uses the system proxy. To name one, signed in as you, run
  `$env:ANALYTICS_HUB_PROXY = 'http://proxy:8080'` first. If the proxy blocks GitHub's download host,
  download the zip in a browser and set `$env:ANALYTICS_HUB_ZIP` to its path, or use `-ZipPath`.
- **Constrained Language Mode** works: the launcher only uses commands allowed there. It skips
  keeping the PC awake, so keep it plugged in and awake yourself.
- **Remove it** with `.\install.ps1 -Uninstall` (from the download-and-run steps above), or by
  deleting `%LOCALAPPDATA%\AnalyticsHub`. That doesn't touch what's in your tenant, or your
  install record in `Documents\Analytics Hub`. To remove what's in your tenant, use **Uninstall**
  in the installer first.

What it can't get past: AppLocker or Windows Defender Application Control rules that block
programs under your profile stop the unpacked `node.exe` just as they stop the exe. Some
endpoint protection products flag `irm | iex`; the download-and-run command above avoids it. If
that's you, use [Azure Cloud Shell](#locked-down-tenant--azure-cloud-shell).

## Locked-down tenant / Azure Cloud Shell

If your PC can't run the exe or the PowerShell command (AppLocker, WDAC, or no local PowerShell at
all), run the installer in [Azure Cloud Shell](https://shell.azure.com) instead. Nothing runs on
your PC: the installer runs in Cloud Shell and asks its questions in the terminal. Choose
**PowerShell** in Cloud Shell and paste the same command:

```powershell
irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex
```

In Cloud Shell, `install.ps1` doesn't download the Windows zip. It fetches the release's source
from GitHub at the commit written into `install.ps1`, checks it got that commit, and installs the
installer's packages with `npm ci` from the lockfile. If Cloud Shell's Node.js is older than 22.13,
it downloads the Node.js version the release was built with from nodejs.org and checks its SHA-256
against the list nodejs.org publishes. It all goes in `~/.analytics-hub`. The first run takes a
minute or two.

- **Options.** To pass options or a command, run
  `& ([scriptblock]::Create((irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1))) --use-az status`.
  In Bash, run `pwsh -c "irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1 | iex"`.
- **Later commands.** It leaves `~/.analytics-hub/analytics-hub` behind, which works from Bash or
  PowerShell, for example `~/.analytics-hub/analytics-hub status`. To update, run the `irm` command
  again.
- **Terminal only.** Cloud Shell can't open the installer's page in your browser, so `--ui` isn't
  available. The terminal asks the same questions.
- **Signing in.** By default the installer signs you in with a code: it shows a code and a link,
  and you sign in on any device. The tokens stay in memory, so each run asks again. Cloud Shell's
  own sign-in, which the Azure CLI uses until you sign it in, can't get tokens for some of the APIs
  the installer uses. To use `--use-az`, first run `az login --use-device-code`. The installer
  checks the Azure CLI can reach every API it uses before it changes anything, and says which it
  couldn't. The Azure CLI stays signed in between Cloud Shell sessions.
- **If Conditional Access blocks sign-in with a code**, Cloud Shell can't run the installer:
  both ways of signing in use a code there. Ask whoever manages Conditional Access, or run the
  installer on a PC that's allowed.
- **Keep the install record.** It's in `~/analytics-hub/valuelens-install.json`. Your home folder
  is kept between sessions only if Cloud Shell has a storage account (it then has `~/clouddrive`);
  `install.ps1` warns if it doesn't, and so may a tenant policy that changes new storage accounts
  so Cloud Shell can't mount them. Without the record, running the installer again sets up a
  second copy, so in that case download it before you close Cloud Shell: choose **Manage files** >
  **Download** and enter `analytics-hub/valuelens-install.json`. The installer reminds you at the
  end of each run. In a new session, upload it with **Manage files** > **Upload** and run the
  installer again: it moves the uploaded record from your home folder to where it looks. To carry
  on from a PC later, put the record in `Documents\Analytics Hub`.
- **Idle timeout.** Cloud Shell ends a session after 20 minutes without input. If that stops the
  installer, run the same command again: it reuses what's in the install record, skips finished
  steps and doesn't create a second app. `--no-wait` saves waiting for the first load.
- **The app.** The installer builds the app from source in Cloud Shell and deploys it with your
  installer sign-in, so Rayfin doesn't open a browser. The build needs a few hundred MB in your
  home folder (Cloud Shell gives you 5 GB). If deploying fails, copy the install record to a
  Windows PC and run `deploy-app` there.
- **Remove it** with
  `& ([scriptblock]::Create((irm https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest/download/install.ps1))) -Uninstall`,
  or by deleting `~/.analytics-hub`. Your install record stays.

`install.ps1` spots Cloud Shell from the environment variables it sets. To force it either way,
set `$env:ANALYTICS_HUB_CLOUD_SHELL` to `1` or `0` first. Cloud Shell is the PowerShell launcher's
only Linux target; on other Linux or macOS machines, use [Without the exe](#without-the-exe).

## Without the exe

If you can't run the exe, run the installer from a clone of this repo with Node.js 22.13 or later:

```text
cd "installer"
npm install
npx valuelens-install --ui
```

Leave out `--ui` to answer the questions in the terminal. Other commands: `run`, `check`,
`refresh`, `status`, `update`, `deploy-app`, `rotate-secret`, `upload`, `prereqs` and `preview`. Add `--help` for
options. The exe takes the same commands, for example `AnalyticsHubInstaller.exe status`.
`install --yes` keeps the secret in the notebooks for a new Fabric install; read
[the trade-off](../installer/README.md#where-the-secret-goes) first, and add `--key-vault` to use Key Vault instead.
`--secret-days <n>` sets how long the secret in the notebooks lasts.
