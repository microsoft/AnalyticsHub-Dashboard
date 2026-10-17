# Copilot Managed App (preview)

Run the Analytics Hub app on the
[Copilot Managed Runtime](https://learn.microsoft.com/microsoft-365/managed-apps/), where apps built
in Copilot Cowork and Copilot Studio run too. Microsoft hosts it, and people open it from
[managedapps.cloud.microsoft](https://managedapps.cloud.microsoft). It has the same pages as on
Fabric and Azure.

> **Preview.** So far it has been deployed and published once, in a demo tenant. Nothing else has
> been tested. Try it with a few people first, and
> [open an issue](https://github.com/microsoft/AnalyticsHub-Dashboard/issues) with what you find.

## How it works

- **It loads no data.** It reads the Power BI models that a
  [Fabric or Azure install](../README.md#getting-started) publishes, so set one of those up first.
- **Each viewer reads as themselves**, through their own Power BI connection, so row-level security
  applies to them.
- **There's no installer.** You build it from this repo's `app` folder and deploy it with
  Microsoft's `ms` command line.

| Model | Needed? | Pages |
|---|---|---|
| Analytics Hub Model (`vl`) | Yes | Every page except the two below |
| Consumption Central (`cc`) | Optional | Consumption, and the credits on the Executive summary |
| Agent Evaluator (`ae`) | Optional | Agent Evaluation |

## Before you start

| Who | What | Where |
|---|---|---|
| **Power Platform admin** | Turns on **Allow app creation with the Copilot Managed Runtime command line interface (CLI)** and **External artifacts in managed apps** for the environment you'll deploy to. Both are off by default. With external artifacts on, your organisation is responsible for checking what it deploys | [Power Platform admin center](https://admin.powerplatform.microsoft.com) > **Copilot** > **Settings** > **Managed apps** ([how](https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#control-whether-apps-can-be-created-using-the-cli)) |
| **Power Platform admin** | Allows the Power BI connector's **Run a query** action. It's blocked by default in the environment group Microsoft sets up for managed apps, and [step 5](#steps) shows whether it's allowed. Select **Edit this policy**, then the Power BI connector, and turn the action on. Editing the policy stops Microsoft curating it, so agree that first | Microsoft 365 admin center > **Apps** > **Settings** > **Environment groups** > your group > **Connectors and MCP servers** ([how](https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#customize-the-default-settings)) |
| **Fabric admin** | Turns on [**Semantic Model Execute Queries REST API**](https://learn.microsoft.com/fabric/admin/service-admin-portal-integration#semantic-model-execute-queries-rest-api) | Admin portal > **Tenant settings** |
| **Microsoft 365 admin** | Gives each viewer, including you, a **Power Apps Premium** licence or **Copilot Credits**. For credits, turn on usage-based billing and add viewers to a spending policy for managed apps. Without either, the app is blocked after 20 operations or five minutes. The Power Apps rights that come with Microsoft 365 don't count | Microsoft 365 admin center > **Copilot** > **Cost management** ([how](https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq#what-do-administrators-need-to-set-up-so-users-can-run-apps-with-copilot-credits)) |
| **Workspace admin** | Gives each viewer, including you, **Build** on each model the app reads. The installer gives it to **Analytics Hub Viewers**, so adding people to that group is enough. Below an F64 capacity, viewers also need Power BI Pro, as on the other paths | Each model's **Manage permissions** |
| **You** | [Node.js](https://nodejs.org/) 24.15 or later, Git, and the `ms` CLI: `npm install -g @microsoft/managed-apps-cli` | Your PC |

## Steps

From the `app` folder:

1. **Install.** Run `npm install`.
2. **Point it at your models.** Copy
   [`managed-app.config.example.json`](../app/managed-app.config.example.json) to
   `managed-app.config.json` and replace the IDs. Each is in the model's URL:
   `app.powerbi.com/groups/<workspaceId>/datasets/<itemId>`. Delete the `cc` or `ae` block to hide
   its pages. The file is built into the app, and gitignored. It also takes the `modules`,
   `reporting`, `access` and `ask` blocks that `fabric.config.json` does.
3. **Sign in.** Run `ms auth login --account <email>`. Without `--account` it may sign you in as
   your Windows account. `ms auth status` shows who you are.
4. **Make it a managed app.**
   ```powershell
   ms app init --display-name "Analytics Hub" --repo none --build-command "npm run build:managed"
   ```
   It uses your personal developer environment unless you add `--environment-id <id>`. It writes
   `ms.config.json`, which is gitignored, and adds the CLI to `package.json`. Don't commit that.
5. **Add the Power BI connector.**
   ```powershell
   ms app add data-source --connector shared_powerbi --as action
   ```
   It skips actions the policy blocks, and says how many.
   `ms connector list-actions --connector shared_powerbi --search query` shows which are allowed.
6. **Deploy.** `ms app deploy` builds the app with `npm run build:managed` and uploads it.
7. **Open it.** Run `ms app play`.
8. **Share it.** Run `ms app share <email> --access play`. That opens the app, not the data: each
   viewer also needs **Build** on the models.

To update it, get the latest code and run `ms app deploy` again. `ms app info` shows its links.
To remove it, run `ms app delete`.

## What's different from Fabric and Azure

- **Settings and report packs stay in each viewer's browser.** There's no app database, so one
  person's rates, budgets, prices, task times and packs don't reach anyone else. If the browser
  won't store them, they last until the app closes.
- **Share** has no link to copy. Share with `ms app share` instead.
- **Ask** works only with a Fabric data agent. Add its IDs to the `ask` block and deploy again.
- **Every query is a Power BI connector call.** For a viewer without Power Apps Premium, each call
  costs 0.1 Copilot Credits, and opening the app costs 0.1 more. With Premium, calls count toward
  the viewer's daily Power Platform request limit instead. A connection can make 100 calls a
  minute, and the app paces its queries below that. See the
  [licensing FAQ](https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq).

## Check it worked

Open **Diagnostics** in the sidebar and use the app as a viewer would.

- **Power BI connector** names the operation that ran the queries, or what it tried and why each
  failed. **Re-check connector** tries again, say after an admin changes the policy. To choose the
  operation yourself, add `"connector": { "dataSource": "<name>", "operations": ["<operation>"] }`
  to `managed-app.config.json`.
- **Row-level security:** **Check who the model sees** runs one query. Each viewer should see their
  own sign-in. If it shows the app's owner or a service account, row-level security isn't applying
  per viewer. Workspace Admins, Members and Contributors aren't filtered, so test as someone with
  only the Viewer role or **Build**.
- **Cost and throttling** counts connector calls, by page and in the busiest minute, and estimates
  the Copilot Credits. It warns at 80% of the limit. If the rates change, set `launchCredits`,
  `creditPerCall` or `throttleLimit` in the config's `diagnostics` block. On a model without
  org-scoped access, one failed call is expected: the app checks for the `Access Scope` table.
- **Copy results** copies it all as JSON.

## If something goes wrong

| What you see | What to do |
|---|---|
| `ms app deploy` says external artifact deployment isn't enabled | Turn on **External artifacts in managed apps** for that environment. If its environment group has a published rule, change it on the group's **Rules** |
| `ms app play` says the app can't be found | The browser signed you in with another account. Open the link in an InPrivate window, and sign in with the account you deployed with |
| **Diagnostics** says no data source has the query operation | An admin allows **Run a query** (see [Before you start](#before-you-start)). Then run steps 5 and 6 again |
| **Diagnostics** says a data policy blocks the Power BI connector | An admin allows the connector in that environment's policy. Then select **Re-check connector** |
| Power BI refuses the queries | Check the viewer has **Build** on the model, and that **Semantic Model Execute Queries REST API** is on |
| The app is blocked after a few minutes | The viewer needs Power Apps Premium or Copilot Credits |

More from Microsoft:
[CLI quickstart](https://learn.microsoft.com/microsoft-365/managed-apps/developer/quickstart-managed-apps-cli) ·
[CLI reference](https://learn.microsoft.com/microsoft-365/managed-apps/developer/ms-cli-command-reference) ·
[Governance settings](https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance) ·
[Licensing FAQ](https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq).
