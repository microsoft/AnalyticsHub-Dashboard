# Fabric notebooks (set up by hand)

The [installer](../../installer/) does all of this for you. Use these steps only if you can't use it.

## Before you start

1. **Register an app** in Entra. Add the Microsoft Graph application permissions listed in
   [PERMISSIONS](../../docs/PERMISSIONS.md), grant admin consent, and create a client secret.
2. **Store the secret** in an Azure Key Vault. Anyone who runs the notebooks needs the
   *Key Vault Secrets User* role on it.
3. **Create a Lakehouse** in your Fabric workspace with **Lakehouse schemas** turned on.

## Load the data

1. **Import 4 notebooks.** In the workspace, choose **Import** > **Notebook** >
   **From this computer**, and pick:

   | Notebook | Writes |
   |---|---|
   | `Copilot_Audit_Log_Direct_Ingester.ipynb` | `copilot_interactions_parsed`, `audit_source_status` |
   | `Copilot_Licensed_Users_Direct_Ingester.ipynb` | `copilot_licensed_users` |
   | `Copilot_Org_Data_Direct_Ingester.ipynb` | `copilot_org_data` |
   | `Copilot_Audit_Log_Processor.ipynb` | `copilot_interactions_curated` |

2. **Attach the Lakehouse** to each notebook as its default Lakehouse.
3. **Fill in the first cell** of the 3 ingesters: `TENANT_ID`, `CLIENT_ID` and `CLIENT_SECRET`.
   To read the secret from Key Vault, set:

   ```python
   CLIENT_SECRET = notebookutils.credentials.getSecret('https://<vault>.vault.azure.net/', '<secret-name>')
   ```
4. **Run the 3 ingesters.** For the first run, set `MODE = 'backfill'` in the audit ingester. It
   loads 30 days (`BACKFILL_DAYS`, up to 180). Afterwards, set it back to `'incremental'`. A later
   backfill reloads its days and keeps older rows. On a large tenant, read
   [A large tenant](#a-large-tenant) first. The notebook reads the Office 365 Management
      Activity API, which holds the last 7 days; for older history or another source, see
      [Where the audit log comes from](#where-the-audit-log-comes-from).
5. **Run `Copilot_Audit_Log_Processor`** once the ingesters finish.
6. **Open the template** in Power BI Desktop, June 2024 or later, and publish it:
   - [`ValueLens - Fabric.pbit`](../ValueLens%20-%20Fabric.pbit): enter the Lakehouse's **SQL analytics endpoint** and its name.
   - Or [`ValueLens - Fabric OneLake.pbit`](../ValueLens%20-%20Fabric%20OneLake.pbit): enter the workspace ID and the Lakehouse ID.
7. **Schedule it** with the [pipeline](../pipelines/README.md).

To check the data, run `ValueLens_Data_Check`. It changes nothing.

## Optional notebooks

Run these before the processor.

| Notebook | Writes | Before you run it |
|---|---|---|
| `Copilot_Agent365_Registry_Ingester` | `agents_365` | Needs an Agent 365 licence and the extra Graph permissions in [PERMISSIONS](../../docs/PERMISSIONS.md). Fill in the first cell. |
| `Copilot_Agent365_Lander` | `agents_365` | Use this instead of the registry ingester if you don't have an Agent 365 licence. Export the agent list from the Microsoft 365 admin center to `Files/agent365/agents.csv`. |
| `Copilot_ProductFeedback_Ingester` | `user_feedback` | Export product feedback from the Microsoft 365 admin center (**Health** > **Product feedback**) to `Files/product_feedback/`. |
| `Copilot_M365_Activity_Ingester` | `m365_activity_daily` | Fill in the first cell. Only DataHub reads this table; the templates don't. |
| `Copilot_Defender_Ingester` | `defender_*` (7 tables) | Needs Defender for Endpoint P2 or Defender for Cloud Apps, and `ThreatHunting.Read.All` (plus `CloudApp-Discovery.Read.All` for Cloud Discovery). Fill in the first cell. Edit `Files/defender/ai_watchlist.csv` to change the AI tools it looks for. Probes you aren't licensed for are skipped. |
| `Copilot_Resource_Graph_Ingester` | `arg_agent_config`, `arg_environments`, `arg_agent_flows`, `arg_foundry_resources`, `arg_status` | Agent configuration (sign-in, quarantine, connectors, web search, sharing) and Foundry accounts and projects, from Azure Resource Graph. Fill in the first cell. Run it after the Agent 365 notebook, so agents link to their Title ID. The app registration needs the roles in [PERMISSIONS](../../docs/PERMISSIONS.md#azure-resource-graph). When Resource Graph won't return agents, it reads the newest file the **Analytics Hub - Agent inventory** flow drops in `Files/arg_inventory/`. A refused probe never fails the notebook; `arg_status` says why. |
| [Workday org data](workday-org-data/README.md) | `copilot_org_data` | Adds HR columns to the org data. Follow its README. |
| `AnalyticsHub_Upload_Router` | `analytics_hub_upload_log` | Run it first. It reads any export dropped in `Files/analytics_hub_uploads`, recognises it from its headers, moves it to the folder its notebook reads, and archives it to `_processed`. Set `ENABLED_SOURCES` to the sources you use. The installer sets this up for you. |
| `AnalyticsHub_Load_Status` | `load_log` | The pipeline's last step, run whatever happened before it. It writes one row per source with its status and, for a failure, the reason in plain words. A source that loaded but couldn't read everything is a `Warning`, with `reason_kind` set to `empty`, `forbidden` or `unlicensed`. The notebook reads that from `arg_status`, `defender_status`, `evaluator_status` and `audit_source_status`. It fails when a load failed, so the run shows as failed; warnings don't fail it. Run by hand, it does nothing: it needs the pipeline's run ID. |
| `AnalyticsHub_Support_File` | `Files/support/analyticshub-support-*.zip` | For a set-up done by hand, when you need help. It writes the same redacted support file as the installer: recent runs and their errors, `load_log`, row counts (never rows) and a log summary. Secrets are removed and people are hashed. Open it to check before you send it. |
| `agent-evaluator/Copilot_Agent_Transcript_Parser` | `agent_*`, `evaluator_status` | Copilot Studio conversations for the [Agent Evaluator](../Add%20Agent%20Evaluator/README.md). An environment's first run reads `FIRST_READ_DAYS` (180) back, and each later run reads `LOOKBACK_DAYS`. `evaluator_status` holds one row per environment, saying how many transcripts it read over how many days, and why there were none. So a run that succeeds with nothing to show can still be explained. |

## Settings you might change

| Setting | Notebook | Change it to |
|---|---|---|
| `AGENT_IDENTITY_PATTERNS` | Processor | Add your own service accounts. Accounts that match, such as Security Copilot agents, aren't counted as people. |
| `AGENT_TYPE_OVERRIDES_TABLE` | Processor | The optional Lakehouse table (columns `key`, `Agent_Type`) that corrects an agent's type. Default `agent_type_overrides`; skipped when the table doesn't exist. See [agent type and publisher](../../docs/DATA-DICTIONARY.md#agent-type-and-publisher). |
| `INCLUDE_RAW_PASSTHROUGH` | Processor, registry ingester | `True` to keep the raw payloads. They can hold names, file names and URLs, so review privacy first. Then run the processor once with `WRITE_MODE = 'overwrite'`. |
| `MAX_CONCURRENT_QUERIES`, `CHUNK_HOURS` | Audit ingester | Lower them if audit windows fail on a large tenant. See [A large tenant](#a-large-tenant). |
| `WINDOW_RETRIES`, `MIN_CHUNK_HOURS` | Audit ingester | How often a failing audit window is resent (default `3`), and the smallest size it is split down to (default `1` hour). |
| `INCREMENTAL_LOOKBACK_DAYS` | Processor | Days before the newest audit record whose months each `merge` run recomputes (default `14`), for records that arrive late. Other months are recomputed only when their rows change. |
| `WRITE_MODE` | Processor | `'overwrite'` once to rebuild every month of `copilot_interactions_curated`, for example after a large licence or agent-registry change. Months a `merge` run doesn't recompute keep the licence and agent values from when they were processed. |
| `TRANSCRIPT_STAGING_DIR`, `PARSE_CHUNK_ROWS` | Agent Evaluator | Where transcript pages are staged as JSONL (default `Files/_transcript_staging`), and how many transcripts each Spark task parses at a time (default `200`). |
| `RUN_OPTIMIZE` | Processor, M365 activity ingester, Agent Evaluator | `False` to skip compacting the tables after the writes. On by default: each run ends with `OPTIMIZE ... VORDER` on the tables it wrote, so the semantic model reads a few large files. In the M365 activity ingester and Agent Evaluator a failed compaction is reported and the run carries on. |
| `TIME_BUDGET_MIN` | Audit ingester | Minutes to spend fetching before the run stops and leaves the rest to the next run (default `0`, no limit). Set it below the pipeline activity's timeout. |

## An audit window keeps failing

On large tenants, Purview sometimes ends an audit query with status `failed` or `cancelled`,
most often when many queries run at once. Graph runs about 10 audit queries at a time per
tenant, and that includes searches other admins start in the Purview portal.

The audit ingester recovers by itself:

1. It sends a failed window again as a new query, after a growing wait (about 1, 2, then
   4 minutes), up to `WINDOW_RETRIES` times.
2. If the window still fails, it splits it in half (for example 8h, 4h, 2h, then 1h) and queries
   the halves, down to `MIN_CHUNK_HOURS`.
3. After a failure or an HTTP 429, it runs fewer queries at once for the rest of the run.
4. It tries every window and then prints a summary. It writes only when every window succeeded.

If it still ends with `N audit window(s) still failed`, nothing was written. Rerun it with
`MODE = 'backfill'` and the same `BACKFILL_DAYS`. Windows that succeeded are reused, so only the
listed windows are queried again. Don't switch to `'incremental'` until a backfill finishes: an
incremental run refuses to start while an older window was never recovered. To accept that gap,
set `ALLOW_UNRECOVERED_GAPS = True`.

## A large tenant

Every audit query waits in a queue for a few minutes, however little it returns, so the first
load's time grows with the number of windows. On a tenant with tens of thousands of people, an 8h
window can also hold too many records: the audit service then fails it after an hour or more, and
a manual Purview search of the same 8h fails too. For more than about 10,000 people:

- Set `CHUNK_HOURS = 2` and `WINDOW_RETRIES = 1`, so a window that fails is split after one
  retry instead of three.
- Set `LOOKBACK_DAYS = 3`. Each incremental run queries the trailing `LOOKBACK_DAYS` again, and
  with 2h windows 7 days is 84 queries. Records that arrive more than 3 days late are missed.
- Set `TIME_BUDGET_MIN` below the pipeline activity's timeout (for example `300` with a 6-hour
  timeout). When the budget runs out, the run stops before writing anything and the next run
  carries on: finished windows are reused, and queries still running in the audit service are
  picked up rather than sent again. The budget also covers waits while Graph is throttling (HTTP 429), so a throttled
  run stops at the budget instead of running on to the activity's timeout.
- Start with the default 30 days. Load more later with a backfill run, which keeps the rows older
  than the days it reloads.
- Use an F64 or larger capacity, and don't run audit searches in the Purview portal while it runs.

A tenant can start at least 200 audit searches in a rolling 24 hours, shared with other admins and
tools, and with 2h windows a 30-day first load needs about 360. When Graph refuses new searches
(HTTP 429 with a wait over `QUOTA_RETRY_AFTER_SEC`, default 300 seconds), the run stops sending new
ones, finishes the searches it already started, writes nothing and fails with a message saying so.
The next run carries on the same way as after a time budget. A window whose search reaches the
service's record cap is split rather than kept incomplete.

The installer does this when you choose **More than 10,000** people. A new install starts on that
answer when the installer counts more than 10,000 people with a licence and an enabled account. It
also gives the loads and the model refresh longer time limits. For a smaller tenant it uses 24h
windows, which need fewer queries each day.

The Agent 365 registry ingester refreshes each agent's detail on its own day of the week (a hash of
the agent ID picks it), so a daily run refreshes about a seventh of the agents, not all of them on
one day. New and changed agents are always fetched first. `TIME_BUDGET_MIN` (default 75 minutes;
the installer sets 120, or 270 for more than 10,000) caps the time spent on those scheduled
refreshes: when it runs out, the ingester leaves the rest to the next run and writes what it has.
`0` means no limit. Set it below the pipeline activity's timeout.

## Where the audit log comes from

`Copilot_Audit_Log_Direct_Ingester` reads Copilot interaction records (record type
`CopilotInteraction`) from one of these, set by `AUDIT_SOURCE` in its parameters cell. Every source
writes the same rows to the same table, keyed by the record's `Id`, so the processor, the model and
the report don't change.

| `AUDIT_SOURCE` | Reads | Needs |
|---|---|---|
| `'feed'` (the default, and new installs) | The Office 365 Management Activity API (`Audit.General` content), which holds the last 7 days | `ActivityFeed.Read` (Office 365 Management APIs), an application permission with admin consent |
| `'auto'` (optional) | Microsoft Sentinel's `CopilotActivity` table for the hours it holds, otherwise the Management Activity API | `ThreatHunting.Read.All` (Microsoft Graph) and `ActivityFeed.Read`, both with admin consent |
| `'graph'` (installs from before this option) | The Microsoft Graph audit search (`/security/auditLog/queries`) | `AuditLogsQuery.Read.All` |

**Why the Management Activity API.** A Graph audit search is a job the audit service runs in the
background: each window waits minutes to hours, a tenant gets about 200 searches a day, and on a
large tenant windows fail or time out. The Management Activity API serves files the service has
already written, with no search quota; it's the API most audit collectors use for routine loads.
Sentinel answers a query over a table it has already indexed, and holds records for as long as the
workspace keeps them, so choose `'auto'` if your tenant already connects Sentinel's Microsoft
Copilot connector.

**What each source reads.**

- `'feed'`: the last 7 days at most. The first run starts the tenant's `Audit.General`
  subscription. Its first content can take up to 12 hours to appear, so the first run may load
  nothing; later runs do.
- `'auto'`: Sentinel, when its Microsoft Copilot data connector is connected, for every hour from
  the table's first Copilot record; the Management Activity API for the hours Sentinel doesn't
  hold. Without Sentinel, or with no Copilot records in it yet, it uses the Management Activity
  API and notes it; that isn't a warning.
- Neither reads Graph unless `GRAPH_FOR_HISTORY` is `True`. Without it the first load covers
  what Sentinel holds, else 7 days, and older windows are left out (the run says which). An
  overwrite then becomes a merge, so history already in the table stays. To load older history,
  choose Graph history in the installer (Advanced settings, `install --graph-history`, or
  `run --backfill-days <n> --graph-history` for one reload): the pipeline's `AuditGraphHistory`
  parameter sets `GRAPH_FOR_HISTORY` on history loads only. Or set `GRAPH_FOR_HISTORY = True` by
  hand for one run. It's slow on a large tenant and needs `AuditLogsQuery.Read.All`. Or run with
  `AUDIT_SOURCE = 'graph'`.

Run one audit ingester at a time. Wait for the scheduled audit load to finish before starting a
history reload: simultaneous runs can race while writing checkpoints or staged files.

**Set up Sentinel's connector** (only for `'auto'`). In the Microsoft Defender portal (or the Azure portal, under
Microsoft Sentinel), open **Content hub**, install **Microsoft Copilot**, then under **Data
connectors** open **Microsoft Copilot** and choose **Connect**. A Security Administrator or Global
Administrator connects it, on a Sentinel workspace onboarded to the Defender portal. Records reach
`CopilotActivity` from the time it's connected, not before.

**Other settings** in the parameters cell:

| Parameter | Default | What it does |
|---|---|---|
| `SENTINEL_QUERY_VIA` | `'hunting'` | `'hunting'` queries through Graph advanced hunting (`ThreatHunting.Read.All`). `'loganalytics'` queries the Log Analytics workspace directly; give the app the **Log Analytics Reader** role on it and set `SENTINEL_WORKSPACE_ID`. |
| `SENTINEL_WORKSPACE_ID` | blank | The Log Analytics workspace ID. Blank with `'hunting'` uses the primary workspace. |
| `SENTINEL_TABLE` | `'CopilotActivity'` | The table the connector fills. |
| `GRAPH_FOR_HISTORY` | `False` | `True` reads the windows no other source holds from Graph: slow, for a history load. The pipeline sets it from `AuditGraphHistory`, which the installer turns on for history loads only when you choose Graph history. |
| `FEED_HOST` | `'manage.office.com'` | GCC: `manage-gcc.office.com`. GCC High: `manage.office365.us`. DoD: `manage.protection.apps.mil`. |
| `FEED_PUBLISHER_ID` | blank | Your tenant ID, to use a Management API quota of your own. |

`AUDIT_SOURCE` also takes `'sentinel'` to read only Sentinel. `'feed'` and `'sentinel'` fail the
run, with the fix, when their source can't be read. The installer sets `'feed'` for new installs,
or the source you choose under [Advanced settings](../../installer/README.md#advanced-settings), or
with `install --audit-source feed|auto|graph`. The Azure target always uses Graph.

Each run writes `audit_source_status`, one row per source it tried, with `Status` `ok`, `empty`,
`skipped`, `forbidden` or `error`. `AnalyticsHub_Load_Status` reads it, so a run that loaded but
wasn't allowed to read Sentinel, say, shows as a Warning with the reason.

Run the installer's `check-audit` command to test the selected sources as the app. It checks the
`Audit.General` subscription and one day's content listing and, under `'auto'`, queries Sentinel
for a Copilot interaction. It does not start a subscription or run Graph audit search. A readable
content listing alone does not prove that Copilot records are present; the notebook filters the
downloaded content to record type 261. An expired or unreadable blob stops the load without
advancing its listing checkpoint, rather than silently accepting missing records.

## Empty audit windows

Before its first search the audit ingester reads the app's Graph token and stops with the fix if
the token is for another tenant than `TENANT_ID`, or lacks the `AuditLogsQuery.Read.All`
application permission. The per-service `AuditLogsQuery-*` permissions (Exchange, SharePoint and
the like) don't cover Copilot interactions.

The audit service can answer a search with no records and add them later, for example during a
service incident. Windows in the trailing `LOOKBACK_DAYS` are queried again on every run. A window
still empty when it leaves the look-back is queried once more if it ended in the last
`EMPTY_RECHECK_DAYS` (default 30; `0` turns this off), oldest first and at most `EMPTY_RECHECK_MAX`
(default 24) a run. Each one is an audit search, so lower the cap on a tenant near its daily
search limit. If a run stops before writing (a throttled or failed window, `TIME_BUDGET_MIN`), the
windows it queried once more stay flagged in `_manifest.json` (`recheck_pending`); the next run
reuses what they fetched and writes it. A backfill only re-queries empty windows inside its own
range. When every window in a run comes back empty, the run says what to check.

## People show as IDs

If licensed users show as 32-character IDs, Microsoft 365 reports are concealing names. In the
Microsoft 365 admin center, go to **Settings** > **Org settings** > **Services** > **Reports** and
clear **Display concealed user, group, and site names in all reports**. Then rerun the licensed
users ingester and the processor, and refresh the report.