# Copilot Managed App (preview)

Run the Analytics Hub app on the
[Copilot Managed Runtime](https://learn.microsoft.com/microsoft-365/managed-apps/), where apps built
in Copilot Cowork and Copilot Studio run too. Microsoft hosts it, and people open it from
[managedapps.cloud.microsoft](https://managedapps.cloud.microsoft). It has the same pages as on
Fabric and Azure.

> **Preview.** So far it has been deployed once, by hand, in a demo tenant. The setup command has
> only been tested offline. Try it with a few people first, and
> [open an issue](https://github.com/microsoft/AnalyticsHub-Dashboard/issues) with what you find.

## How it works

- **It loads no data.** It reads the Power BI models that a
  [Fabric or Azure install](../README.md#getting-started) publishes, so set one of those up first.
- **Each viewer reads as themselves**, through their own Power BI connection, so row-level security
  applies to them.
- **One command sets it up.** It runs Microsoft's managed apps command line for you, and installs
  it just for this.

| Model | Needed? | Pages |
|---|---|---|
| Analytics Hub Model (`vl`) | Yes | Every page except the two below |
| Consumption Central (`cc`) | Optional | Consumption, and the credits on the Executive summary |
| Agent Evaluator (`ae`) | Optional | Agent Evaluation |

## Before you start

Your admins turn these on once. Setup checks what it can, and says what's missing. It never
changes them.

| Who | What | Where |
|---|---|---|
| **Power Platform admin** | Turns on **Allow app creation with the Copilot Managed Runtime command line interface (CLI)** and **External artifacts in managed apps** for the environment you'll deploy to. Both are off by default. With external artifacts on, your organisation is responsible for checking what it deploys | [Power Platform admin center](https://admin.powerplatform.microsoft.com) > **Copilot** > **Settings** > **Managed apps** ([how](https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#control-whether-apps-can-be-created-using-the-cli)) |
| **Power Platform admin** | Allows the Power BI connector's **Run a query** action. It's blocked by default in the environment group Microsoft sets up for managed apps, and setup checks it before it makes anything. Select **Edit this policy**, then the Power BI connector, and turn the action on. Editing the policy stops Microsoft curating it, so agree that first | Microsoft 365 admin center > **Apps** > **Settings** > **Environment groups** > your group > **Connectors and MCP servers** ([how](https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#customize-the-default-settings)) |
| **Fabric admin** | Turns on [**Semantic Model Execute Queries REST API**](https://learn.microsoft.com/fabric/admin/service-admin-portal-integration#semantic-model-execute-queries-rest-api) | Admin portal > **Tenant settings** |
| **Microsoft 365 admin** | Gives each viewer, including you, a **Power Apps Premium** licence or **Copilot Credits**. For credits, turn on usage-based billing and add viewers to a spending policy for managed apps. Without either, the app is blocked after 20 operations or five minutes. The Power Apps rights that come with Microsoft 365 don't count | Microsoft 365 admin center > **Copilot** > **Cost management** ([how](https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq#what-do-administrators-need-to-set-up-so-users-can-run-apps-with-copilot-credits)) |
| **Workspace admin** | Gives each viewer, including you, **Build** on each model the app reads. The installer gives it to **Analytics Hub Viewers**, so adding people to that group is enough. Below an F64 capacity, viewers also need Power BI Pro, as on the other paths | Each model's **Manage permissions** |

## Steps

1. **Install [Node.js](https://nodejs.org/) 24.15 or later.**
2. **Get the code.** From the
   [latest release](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest), download
   **Source code (zip)**, and unzip it.
3. **Run setup.** Open PowerShell in its `app` folder (in File Explorer, right-click the folder >
   **Open in Terminal**), and run:

   ```powershell
   npm.cmd run deploy:managed
   ```

It asks for each model's link, or offers the ones in your install record. Then it signs you in,
deploys the app, asks who to share it with, and opens it. It takes a few minutes, longer the first
time. If it stops, run it again: it picks up where it stopped.

On macOS or Linux, run `npm run deploy:managed`.

### Options

Add them after `--`, for example `npm.cmd run deploy:managed -- --share alex@contoso.com`.

| Option | What it does |
|---|---|
| `--share <list>` | Shares it with these emails or group object IDs, comma-separated |
| `--environment-id <id>` | Deploys to this environment, not your developer environment |
| `--display-name <name>` | Names a new app. The default is **Analytics Hub** |
| `--device-code` | Signs in with a code, in any browser. Use it if the wrong account signs in |
| `--new` | Makes another app, instead of updating this one |
| `--dry-run` | Shows the steps as `ms` commands, to run yourself. Runs nothing |

Setup saves the models in `app\managed-app.config.json`. It also takes the `modules`, `reporting`,
`access` and `ask` blocks that `fabric.config.json` does. Run setup again after you change it.

## Update or remove

- **Update:** get the new release's code, and run setup again. It remembers your app, so it
  updates it instead of making another.
- **Set it up with `ms` commands before?** Copy `ms.config.json`, `managed-app.config.json`,
  `generated` and `.ms` from the old `app` folder into the new one. Then run setup: it updates that
  app.
- **Remove:** in `app`, run `npm.cmd run remove:managed`. It asks first.

It remembers the app in `%LOCALAPPDATA%\AnalyticsHub-ManagedApp`: its ID and environment, the
Power BI connector's definitions, and the models' IDs. Nothing there is secret.

## What's different from Fabric and Azure

- **Settings and report packs stay in each viewer's browser.** There's no app database, so one
  person's rates, budgets, prices, task times and packs don't reach anyone else.
- **Share** in the app has no link to copy. Share with `--share` instead.
- **Ask** works only with a Fabric data agent. Add its IDs to the `ask` block, and run setup again.
- **Every query is a Power BI connector call.** For a viewer without Power Apps Premium, each call
  costs 0.1 Copilot Credits, and opening the app costs 0.1 more. With Premium, calls count toward
  the viewer's daily Power Platform request limit instead. A connection can make 100 calls a
  minute, and the app paces its queries below that. See the
  [licensing FAQ](https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq).

## Check it worked

Do each as a viewer would. **Diagnostics** is in the app's sidebar.

1. **Sign-in.** Open the link setup prints. It opens as you. If it opens as another account, use an
   InPrivate window.
2. **Models.** The pages show data. In **Diagnostics**, **Power BI connector** names the operation
   that ran the queries, or what it tried and why each failed.
3. **Sharing.** Someone you shared it with opens the same link. Without **Build** on the models,
   they see the app but no data.
4. **Each viewer as themselves.** As that viewer, select **Diagnostics** > **Check who the model
   sees**. It should show their own sign-in. If it shows you or a service account, row-level
   security isn't applying per viewer. Test as someone with only the Viewer role or **Build**:
   workspace Admins, Members and Contributors aren't filtered.

Also in **Diagnostics**:

- **Re-check connector** tries again, say after an admin changes the policy. To choose the
  operation yourself, add `"connector": { "dataSource": "<name>", "operations": ["<operation>"] }`
  to `managed-app.config.json`.
- **Cost and throttling** counts connector calls, by page and in the busiest minute, and estimates
  the Copilot Credits. It warns at 80% of the limit. If the rates change, set `launchCredits`,
  `creditPerCall` or `throttleLimit` in the config's `diagnostics` block. On a model without
  org-scoped access, one failed call is expected: the app checks for the `Access Scope` table.
- **Copy results** copies JSON to share in an issue: the counts and assumptions, each operation tried
  and how it came out, and, once you've checked, whether the model sees the signed-in viewer. It
  leaves out names, sign-ins, IDs, URLs and error messages. Read it before you share it.

## If something goes wrong

| What you see | What to do |
|---|---|
| `running scripts is disabled on this system` | Use `npm.cmd`, as in the [steps](#steps). Don't change the execution policy |
| `Missing script: "deploy:managed"` | The code is too old. Download the [latest release](https://github.com/microsoft/AnalyticsHub-Dashboard/releases/latest)'s **Source code (zip)** |
| Setup stops with `Ask your … admin` | Send them the step it prints. Once it's done, run setup again |
| Setup stops with anything else | Do what it says, then run it again. It picks up where it stopped |
| The app opens as the wrong account, or can't be found | Open the link in an InPrivate window, and sign in with the account you deployed with |
| **Diagnostics** says no data source has the query operation | An admin allows **Run a query** (see [Before you start](#before-you-start)). Then run setup again |
| **Diagnostics** says a data policy blocks the Power BI connector | An admin allows the connector in that environment's policy. Then select **Re-check connector** |
| Power BI refuses the queries | Check the viewer has **Build** on the model, and that **Semantic Model Execute Queries REST API** is on |
| The app is blocked after a few minutes | The viewer needs Power Apps Premium or Copilot Credits |

More from Microsoft:
[CLI quickstart](https://learn.microsoft.com/microsoft-365/managed-apps/developer/quickstart-managed-apps-cli) ·
[CLI reference](https://learn.microsoft.com/microsoft-365/managed-apps/developer/ms-cli-command-reference) ·
[Governance settings](https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance) ·
[Licensing FAQ](https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq).
