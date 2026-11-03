# Contributing to Analytics Hub

Thanks for helping make Analytics Hub more useful and reliable.

## Propose a change

For a bug, include Fabric or Azure, the installer version, the step that failed,
whether you used demo mode or your own data, and reproducible steps. For a feature,
explain the use case, data source and expected result. Discuss substantial changes
in an issue before rebuilding templates or changing source contracts.

Create a focused branch, make the change, update the affected path documentation,
and open a pull request against `main` using the repository's PR template. Explain
compatibility, validation and any limitations. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately through the
[security policy](SECURITY.md), not a public issue or pull request.

## Reviews and releases

- Every change reaches `main` through a pull request. It needs the `pytest`, `installer` and
  `valuelens-web` checks to pass and an approval from the [code owner](.github/CODEOWNERS),
  Keith, who reviews and merges it.
- Only Keith creates `installer-v*` release tags. Releases are tagged from `main`.

## Run the tests

Run from the repository root with **Python 3.12** (the CI version):

```text
python -m pip install pytest duckdb pandas
python -B -m pytest tests -q
```

No tenant credentials are required. Do not provide production credentials or customer data to
tests.
The optional Spark check in `test_snapshot_safety.py` skips when local PySpark /
Spark is unavailable; the default CI job does not install Spark. Local tests do
not certify Fabric execution, tenant permissions or Desktop / Service refresh.

CI runs the full suite with no exclusions, plus the installer and web app tests below and a
check that `installer/src/azure/main.arm.json` matches `azure/infra/main.bicep`.
The app job generates its Fabric data contract, runs tests, lint and TypeScript checks, and
builds with `npm run build:fabric` without tenant configuration or the deployment-oriented
`rayfin env` prebuild hook. Its commit-labelled artifact is a validation build, not a deployment.

The Power BI templates in [ValueLens](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot)
share the Fabric model's measures and report. Its CI checks them against a pinned release of this
repo, so a DAX or model fix here also needs a matching change there when the pin is bumped.

## Work on the installer

From `installer`:

```text
npm test                       # unit tests with fakes, no sign-in
npm run typecheck              # TypeScript checks over the JSDoc types
npx valuelens-install preview  # writes ./valuelens-preview (ignored by git)
npm run build:exe              # builds dist-exe/AnalyticsHubInstaller.exe (Windows, about 10 minutes)
```

`npm run build:exe` builds the [Analytics Hub app](app/) once, stages it
with the installer and the notebooks, pipeline and templates it deploys, and zips them with a
portable Node.js into a small C# launcher, compiled with the `csc` that comes with the .NET
Framework. Run `npm ci` in the installer and in the app first. `--release` fails rather than warns
when something a published download needs is missing; `--out <dir>` writes the exe somewhere else.
Next to the exe it writes the same payload as `AnalyticsHubInstaller.zip` with its `.sha256`, and
`install.ps1`, the [PowerShell launcher](docs/INSTALL.md#from-powershell), filled in from
[`packaging/launcher/install.ps1`](installer/packaging/launcher/install.ps1) with the zip's
version, URL and SHA-256. Keep that template plain ASCII, and to commands allowed in Constrained
Language Mode, or guard what isn't with `$FullLanguage`.

The [`installer-exe`](.github/workflows/installer-exe.yml) workflow builds, tests and smoke-tests
the exe and `install.ps1` (in PowerShell 7, and in Windows PowerShell 5.1 in Constrained Language
Mode) on pull requests that touch `packaging/`. To publish one, set the version in
`installer/package.json` and push a tag `installer-v<version>`. The workflow drafts a
release with the exe, the zip, their SHA-256 files, `install.ps1` and the release notes from
`packaging/finish-exe.js`. For a release candidate, use a version such as `0.6.8-rc.1`: the
workflow drafts it as a pre-release, which `releases/latest` and the installer's update check
skip. The same
tag makes [`azure-images`](.github/workflows/azure-images.yml) push
`ghcr.io/microsoft/valuelens-jobs` and `valuelens-web` with that version, which Azure installs pull.

Signing happens in CI, never on your computer. Run the ESRP pipeline
([`packaging/sign-installer.azure-pipelines.yml`](installer/packaging/sign-installer.azure-pipelines.yml))
with the tag. It signs the draft's exe with the Microsoft Corporation certificate and replaces its
exe, hash and notes. Then review the draft and publish it. Publishing checks the exe against its
hash. With the repo variable `REQUIRE_SIGNED_INSTALLER` set to `true`, it also requires the
signature. A release that fails goes back to being a draft. Signing leaves the zip and
`install.ps1` as they are; publishing also checks that `install.ps1` expects the published zip's
SHA-256.

## Work on the app and the Azure web app

```text
cd app        && npm ci && npm test   # the app's query and component tests (vitest)
cd azure/web  && npm ci && npm test   # the Azure web proxy
```

See the [app README](app/README.md) and the [Azure README](azure/README.md) for running them
against a workspace or a local SQL database.

## Repository layout

| Folder | What it is | Who needs it |
|---|---|---|
| [`1-fabric/`](1-fabric/) · [`2-azure/`](2-azure/) | Path 1 (Fabric) and Path 2 (Azure): just the setup steps, by the installer or by hand | Everyone |
| [`docs/`](docs/) | The user pages. Published to the [wiki](https://github.com/microsoft/AnalyticsHub-Dashboard/wiki) on every change | Everyone |
| [`installer/`](installer/) | `AnalyticsHubInstaller.exe`: sets up, repairs and updates Fabric or Azure installs | Fabric and Azure |
| [`fabric/`](fabric/) | Notebooks, pipeline, flows and Power BI templates for Fabric. The installer deploys them | Fabric by hand, or to see what's deployed |
| [`app/`](app/) | The Analytics Hub app: a Fabric app item and the web app's front end on Azure | Fabric by hand, or developers |
| [`azure/`](azure/) | Bicep, Container Apps jobs, SQL schema, web app and Teams package for Azure | Azure by hand, or developers |
| [`core/`](core/) | `valuelens_core`, the Python shared by the Azure jobs and the Fabric Defender notebook | Developers |
| [`sharepoint/`](sharepoint/) | Power BI templates for a SharePoint setup, copied unchanged from ValueLens and pinned to a commit. Not shipped yet | Contributors |
| [`samples/`](samples/) | Synthetic sample data for demo mode | Demos |
| [`media/`](media/) | Screenshots and the demo video | Docs |
| [`scripts/`](scripts/) · [`tests/`](tests/) | Maintainer scripts that patch or check the templates, and the tests | Contributors |
| [`ideas/`](ideas/) | Parked ideas. Not part of the product: not built, run, shipped or supported. Still in source downloads, and still scanned and checked | Contributors |

## Repository conventions

- Put setup details in the relevant README (`fabric/`, `azure/`, `installer/`) and shared
  column contracts in the
  [data dictionary](docs/DATA-DICTIONARY.md).
- Keep the root README, `1-fabric/` and `2-azure/` to setup steps only, in order. Background and
  reference go in `docs/`, listed in [docs/README.md](docs/README.md).
- User pages live in `docs/` and publish to the wiki: add a new page to `PAGES` in
  `.github/scripts/publish_wiki.py`. Keep the two paths apart: installer steps in
  [Install](docs/INSTALL.md), by-hand steps in [Manual install](docs/MANUAL-INSTALL.md).
- Preserve existing names, formatting and README tone. Separate measured signals
  from estimates, and document optional sources, toggles and blank-data behaviour.
- Use fabricated fixtures only. Never commit tenant exports, user identities,
  prompts, credentials, private solution packages or populated report files.
  Review notebook outputs and screenshots before attaching them.
- Edit Fabric notebooks in `fabric/notebooks/`. There are no mirrored copies to keep in sync.
- Keep the names that installs in the field depend on: `valuelens-install.json`, the
  `valuelens-*` resource tags, image names and `VALUELENS_*` settings, and the Fabric item
  names that **Repair or change** looks up.
- **`.pbit` templates are binary packages.** Source/helper changes do not update
  shipped templates automatically: rebuild with the relevant repository generator
  or Power BI Desktop workflow. Describe the rebuild, preserve unrelated report /
  model content, and check refresh and visuals in Desktop with fabricated data.
  Do not claim a binary diff alone proves report correctness. Templates in `sharepoint/` are
  copies, never rebuilt here: fix them upstream, then re-pin them as
  [sharepoint/README.md](sharepoint/README.md) says.
- Keep pull requests scoped and check every Markdown link you change. Record the
  exact test command, results and any skipped live validation.

Contributions are provided under the repository's [MIT license](LICENSE).
