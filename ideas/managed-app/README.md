# Copilot Managed App

> **Parked. Not supported.** Use [Fabric or Azure](../../README.md#getting-started).

Not part of the supported product: nothing here is built, run or shipped. It's still in the
repository, so source downloads include it. It's still scanned for security and checked for broken
links.

## Why it's parked

- It needs a Fabric or Azure install anyway.
- Its admin settings are off by default.
- Each viewer needs Power Apps Premium or Copilot Credits, on top of Power BI.
- Its CLI is in preview.
- So it isn't yet a valuable alternative.

## What's here

| File | What it is |
|---|---|
| [SETUP.md](SETUP.md) | How it was set up. History, not working steps |
| [`src/`](src/) | The managed-only code, moved from `app/src`. It doesn't build here |
| [`managed-app.config.example.json`](managed-app.config.example.json) | The config example |
| [`scripts/check-managed-markers.mjs`](scripts/check-managed-markers.mjs) | The marker check CI used to run |

## History

- Added in [#113](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/113), and merged as
  [a49fbd2](https://github.com/microsoft/AnalyticsHub-Dashboard/commit/a49fbd2925e9bf2505a3047d94a1e462ec86a73e).
  CI last built it there.
- Where it plugged in: `git diff a49fbd2^ a49fbd2 -- app/src`.
- The one-command setup is [#114](https://github.com/microsoft/AnalyticsHub-Dashboard/pull/114): a
  draft, parked, not merged.
- History isn't proof that any of it works today.

## Already deployed one?

Parking doesn't delete it, and can't promise it keeps working. Removing it is its owner's call.

The historical step was `ms app delete`, run from the folder it was deployed from. Check Microsoft's
[CLI reference](https://learn.microsoft.com/microsoft-365/managed-apps/developer/ms-cli-command-reference#ms-app-delete)
first.

## Before trying it again

Try it again only when all of these hold:

- It's a valuable alternative to Fabric and Azure.
- Each admin setting is a deliberate, scoped approval. They're off by default.
- The Power BI connector's **Run a query** action is blocked by default for managed apps. Allowing
  it needs an admin's deliberate, scoped approval.
- Proof from an app the CLI actually generates: its `ExecuteDatasetQuery` call works, and runs as
  the viewer, so row-level security applies.
- Each viewer's licence or Copilot Credits agreed, with billing and a spending policy.
- A test environment, permissions and costs agreed before any live test.
- No workarounds.

## What it needed

As at a49fbd2. [SETUP.md](SETUP.md) has the rest.

- **Cost.** The Fabric or Azure install it read from, plus Power Apps Premium or Copilot Credits for
  each viewer. Without Premium, each connector call cost 0.1 Copilot Credits, and opening the app
  0.1 more. With Premium, calls counted toward the viewer's daily Power Platform request limit.
  Viewers still needed Power BI Pro below F64.
- **Access.** Each viewer read through their own Power BI connection, so needed **Build** on each
  model. Deploying it needed two Power Platform settings, the connector's **Run a query** action,
  and the Fabric tenant setting **Semantic Model Execute Queries REST API**.
- **Settings.** There was no app database. Settings and report packs stayed in each viewer's
  browser, so they applied only to that viewer.
- **Sharing.** With `ms app share`. That opened the app, not the data.

## Checks that still run

- CodeQL.
- The docs link check.
- The parked guard, [`test_parked_ideas.py`](../../tests/test_parked_ideas.py). It keeps this code
  out of the app, the installer and the setup docs.
