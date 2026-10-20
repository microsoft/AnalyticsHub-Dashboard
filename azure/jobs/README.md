# valuelens-jobs

The Azure-hosted Analytics Hub's data jobs: one container image, run on a schedule as an Azure
Container Apps job (`infra/modules/containerapps.bicep`). It replaces the Fabric notebooks and
pipeline. The processing logic is the shared DuckDB core in `core/valuelens_core`, kept
in step with the Fabric notebooks by the golden tests in `tests/`. No Spark or JVM is needed.

## Steps

`python -m valuelens_jobs run --steps collect,process,publish,refresh` runs these steps in order.

| Step | What it does | Module |
|---|---|---|
| collect | Licensed users (`Reports.Read.All`), then Copilot interactions from the Purview audit log (`AuditLogsQuery.Read.All`) | core |
| | Org data from `/users` (`User.Read.All`) | orgData |
| | Microsoft 365 daily activity reports (`Reports.Read.All`) | m365Activity |
| | Copilot Studio credits and Viva (Copilot Chat) credits from the drop folder; Azure AI spend, tokens and Copilot pay-as-you-go from Azure Resource Manager | consumption |
| | The Agent 365 registry, from the newest CSV export in the drop folder | agent365 |
| | Product feedback, from every CSV export in the drop folder | productFeedback |
| | Workday org data, from the newest CSV export in the drop folder, after the org data | workday (a data source, with orgData) |
| | Shadow AI and agent risk from Microsoft Defender (`ThreatHunting.Read.All`, `CloudApp-Discovery.Read.All`) | defender |
| | Copilot Studio conversation transcripts from Dataverse (an application user with Bot Transcript Viewer) | agentEvaluator |
| process | Curates interactions with `valuelens_core.curate()` into `curated/copilot_interactions_curated`, recomputing only the months that changed or fall in the lookback window | core |
| publish | Loads curated and raw tables into Azure SQL, rewriting only the days that changed | per module |
| refresh | Refreshes the configured Power BI semantic models and waits for them to finish. The Agent Evaluator model (`ae`) is skipped until `agentEvaluator` is in `VALUELENS_MODULES` and `VALUELENS_DATAVERSE_ENVIRONMENTS` lists an environment (`MODEL_MODULES` in `refresh.py`) | — |

The other commands are:

- `migrate` applies `azure/sql/migrations/V*.sql` and grants the app's reader identity `db_datareader`. The installer runs it on every deploy.
- `process --data-dir <dir>` runs only the processing step, on local files. Add `--full-rebuild` to recompute every month.

**Incremental processing.** `process` saves a fingerprint of each month's source rows. Each run
recomputes only the months whose rows changed, plus the months within
`VALUELENS_PROCESS_LOOKBACK_DAYS` (default 14) of the newest record, for audit records that arrive
late. It rewrites only those monthly files. A recomputed month is curated from all of its source
rows, so it equals a full rebuild. Every month is recomputed when the settings, the
`valuelens_core` code or the source columns change, on the first run after the old single
`part-0.parquet` layout (which that run removes), and with `--full-rebuild` or
`VALUELENS_PROCESS_FULL_REBUILD=true`. Months that aren't recomputed keep the licence and
agent-registry values from when they were last processed.

Any failure is logged and the job exits with code 1, so Container Apps records the run as failed.

## Credit consumption (module `consumption`)

These collectors port the Fabric notebooks `Ingest_Studio`, `Ingest_Viva_Consumption` (its CSV path)
and `Ingest_Azure_AI`. They write the same tables, with the same columns, so the Consumption Central
model reads `dbo.<table>` in Azure SQL. Each collector fails on its own, and the others still run.

- **studio** (`collect/studio.py`) reads `studio/*.csv` from the drop folder. These are the Power
  Platform admin center exports (`*Tenant*`, `*PerAgent*`/`*Agent*` and `*PerUser*`/`*User*`, where
  the first pattern that matches wins) and the flow's licensing-API files (`StudioApiEntitlement*`,
  `StudioApiAgentDaily*`, `StudioApiUserDaily*`). An export takes precedence over API rows for the
  same month (agent and user) or the same day and environment (tenant).
  - The per-user API rows get UPNs from Graph `$batch` on a best-effort basis: a failure is logged,
    and the user is kept without a UPN.
- **viva** (`collect/viva.py`) reads `viva/PersonServiceCreditsMetrics*.csv`, merging on person,
  service, policy and week. `viva/SpendingPolicyMetadata*.csv` replaces `viva_spending_policy`, but
  only when a file is present.
- **azure_ai** (`collect/azure_ai.py`) runs only when `VALUELENS_AZURE_AI_SUBSCRIPTION` is set. It
  collects the last 90 complete UTC days, in two groups:
  - Strict:
    - `azure_ai_spend` (Cost Management)
    - `azure_ai_tokens` (Azure Monitor)
    - `copilot_payg_spend` (Copilot Studio and Cowork pay-as-you-go, for the AI subscription plus
      `VALUELENS_PAYG_SUBSCRIPTIONS`)
  - Best effort; a failure leaves the table as it was:
    - `azure_deployment_health`
    - `azure_solution_spend`
    - `azure_billing_reconciliation`
  - Without that subscription, pay-as-you-go isn't read either, as in Fabric.
  - The managed identity needs Cost Management Reader and Monitoring Reader (or Reader) on each
    subscription.
  - The block of pure helpers is a verbatim copy of the one in `pull_azure_ai.py` and the notebook,
    and `tests/test_azure_ai_collectors.py` keeps the copies identical.

- **resource_graph** (`collect/resource_graph.py`, module `resourceGraph`) ports the Fabric notebook
  `Copilot_Resource_Graph_Ingester`. It writes daily snapshots of `arg_agent_config`,
  `arg_environments` and `arg_agent_flows` (Copilot Studio agents, environments and agent flows, from
  `PowerPlatformResources`), `arg_foundry_resources` (Foundry accounts and projects, from `resources`,
  with lower-case ids that join to Azure AI spend) and `arg_status` (one row per probe: `ok`, `empty`,
  `forbidden`, `error` or `skipped`).
  - Each probe is best effort. A refused probe leaves its table as it was, and the job doesn't fail.
  - The managed identity needs **Reader** at the management group (or the tenant root group) for
    Foundry, and an Entra role such as **Global Reader** for agents. App-only access to
    `PowerPlatformResources` isn't documented. When it's refused or empty, the newest
    `arg_inventory/*.json` in the drop folder is read instead: the **Analytics Hub - Agent
    inventory** flow writes it each day from the Power Platform inventory API, signed in as an admin.
  - With the `agent365` module, `TitleId` comes from its export when that has a `Bot Id` or
    `Entra Agent ID` column. The admin center's export has neither, so `TitleId` stays blank.
  - The shared block is a verbatim copy of the notebook's section 2; `tests/test_resource_graph.py`
    keeps them identical.

Files in the drop folder are never moved or deleted. Every run re-reads all of them and merges the
results idempotently into the state kept in `curated/<table>/part-0.parquet`, as Fabric does with
its Delta tables. The Agent 365 and Workday collectors are the exceptions: they read only the newest
export. The product feedback collector reads every export and rebuilds `user_feedback` from them each
run.

The drop folder has the subfolders `studio/`, `viva/`, `agent365/`, `product_feedback/`, `workday/` and `arg_inventory/`. The Power Automate flow's `flows/`
state is ignored. Where the folder lives depends on the networking mode:

- Public networking uses the storage account's `landing` container (`landing/studio/`,
  `landing/viva/`, `landing/agent365/`, `landing/product_feedback/`, `landing/workday/`).
- Private networking uses SharePoint when `VALUELENS_DROP_SITE_ID` is set. The job reads it
  through Microsoft Graph with the managed identity, which needs `Sites.Selected` and a read grant
  on the site.
  - The site is either a Graph site id (`host,guid,guid`) or `host:/sites/Name`. Both are resolved
    with `GET /sites/{value}`.
  - With `VALUELENS_DROP_DRIVE_ID` set, `VALUELENS_DROP_FOLDER` is a path from that drive's root.
  - With it empty, the folder's first segment names the document library (for example
    `Shared Documents/ValueLens`).

| Table | Source | Publish |
|---|---|---|
| `studio_tenant_daily`, `studio_agent_daily`, `studio_user_daily` | studio | by `usage_date` |
| `studio_agent`, `studio_user` | studio | snapshot |
| `viva_credits_weekly` | viva | by `metric_date` |
| `viva_spending_policy` | viva | snapshot |
| `azure_ai_spend`, `azure_ai_tokens`, `copilot_payg_spend`, `azure_deployment_health`, `azure_solution_spend`, `azure_billing_reconciliation` | azure_ai | snapshot |
| `arg_agent_config`, `arg_environments`, `arg_agent_flows`, `arg_foundry_resources`, `arg_status` | resource_graph | snapshot |

`azure/sql/migrations/V002__consumption.sql` and `V004__resource_graph.sql` create every table up front, so a refresh before
the first collection finds empty tables. A table whose source has never run is skipped at
publish. The consumption tables never trigger the full refresh of the incremental Copilot model.

## Agent 365 registry (module `agent365`)

Optional and off by default. `collect/agent365.py` ports the CSV route of the Fabric notebook
`Copilot_Agent365_Lander`. It reads the newest `.csv` in the drop folder's `agent365/` (by modified
time, then name) and writes it as the `agents_365` snapshot, replacing the last one. The Graph API
route, `Copilot_Agent365_Registry_Ingester`, is Fabric only for now.

- **Columns.** Every column of the export is kept. The 37 columns the model reads are added as
  copies, matched ignoring case, spaces and punctuation through the Lander's aliases; one the export
  lacks loads blank. Headers that collide once normalised are kept once when their values match, and
  fail the step when they don't.
- **Dates.** A `Date created` or `Last Activity Date` before 2000 loads blank, and `Snapshot As Of`
  is the latest `Last updated`, as in the Lander.
- **No data.** With no CSV, the table is left as it is. An export with no rows fails the step instead
  of emptying it.
- **Who reads it.** `resource_graph` runs after it and maps agents to Title IDs through it, and
  `process` uses it for the agent link and behaviour labels. Months that `process` doesn't recompute
  keep the values they had, so after the first export run it once with `--full-rebuild` (or
  `VALUELENS_PROCESS_FULL_REBUILD=true`) to fill older months.
- **Demo mode** doesn't load the Agent 365 sample, and doesn't publish `agents_365`.

| Table | Publish |
|---|---|
| `agents_365` | snapshot |

`azure/sql/migrations/V009__agent365.sql` creates it up front, with the 37 columns and
`Snapshot As Of`. Publish adds any other column the export has.

## Product feedback (module `productFeedback`)

Optional and off by default. `collect/product_feedback.py` ports the Fabric notebook
`Copilot_ProductFeedback_Ingester`. It reads every `.csv` in the drop folder's `product_feedback/`,
in name order, and writes them as the `user_feedback` snapshot, so exports add up. The flow that saves
the emailed export, `Copilot_ProductFeedback_Email_to_OneLake`, is Fabric only for now.

- **Rows.** Each `Feedback Id` is kept once: the latest `Date Submitted UTC`, then the row with the
  most values, then the last file by name, as in the ingester, then the last row.
- **Columns.** Column names stay as exported, and the exports are combined by name. The 23 columns
  the model reads load blank when no export has them. A name that repeats in one file is numbered,
  as Spark does, and fails the step if it still clashes. A header longer than 128 characters can't be
  a SQL column, so it's dropped with a warning.
- **Derived.** `Sentiment` is Positive or Negative from `Feedback Type`, and `Date Submitted Date` is
  the date of `Date Submitted UTC`. `SourceFile` and `LoadDate` record which export each row came
  from and when it was loaded.
- **No data.** With no CSV, the table is left as it is. A missing or blank `Feedback Id`, or no rows
  in any export, fails the step instead of writing rows that can't be deduplicated, or none.
- **Unlike the ingester**, every CSV is read whatever its name (the ingester reads `*feedback*`
  only), headers lose surrounding spaces, and names match ignoring case.
- **Demo mode** doesn't load the product feedback sample, and doesn't publish `user_feedback`.

| Table | Publish |
|---|---|
| `user_feedback` | snapshot |

`azure/sql/migrations/V010__product_feedback.sql` creates it up front, with the 23 columns,
`SourceFile` and `LoadDate`. Publish adds any other column the exports have.

## Workday org data (data source `workday`)

Optional and off by default. It's a data source that comes with org data, not a module: the job runs
it when `VALUELENS_MODULES` has both `orgData` and `workday`. `collect/workday.py` runs the rules of
the Fabric notebook `Copilot_Org_Data_Workday_Lander`, ported to `valuelens_core.workday`. After the
org data, it reads the newest `.csv` or `.txt` in the drop folder's `workday/` (by modified time,
then name) and logs how many older files it ignored.

- **Where it writes.** `VALUELENS_WORKDAY_OUTPUT_TABLE` picks the table. The default, as in the
  notebook, is `copilot_org_data_workday_preview`, a copy to review; the model keeps reading
  `copilot_org_data`. The installer sets `copilot_org_data` and
  `VALUELENS_WORKDAY_ALLOW_BASE_OVERWRITE=true`, as Fabric's installer does, so each run enriches the
  org data itself after the Entra ID load. Any other table fails the step.
- **Matching.** `VALUELENS_WORKDAY_MODE` is `auto` (the default), `enrich` or `standalone`. With
  org data in `raw/copilot_org_data`, `auto` enriches it: the export adds the columns the org data
  doesn't have, matched on its email column (`primaryWorkEmail`, ignoring case and spaces) to
  `PersonId`. The org data's people and values win, even blank ones, and people only in Workday are
  left out. With no org data yet, `auto` lands the export on its own, as the notebook does.
- **Checks.** An export with no rows, a missing or blank email, or two different rows for one email
  fails the step before it writes, as does org data with a blank or repeated `PersonId`, a match rate
  below `VALUELENS_WORKDAY_MIN_MATCH_RATE` (default 0.5) or an empty result. Exact duplicate rows are
  kept once. The org data is then as the Entra ID load left it, and the run carries on.
- **If the org data step fails**, the last enriched org data is the baseline. Its Workday columns
  keep their values, because the org data's values win, until the next good Entra ID load.
- **No data.** With no export, nothing is written.
- **Unlike the notebook**, only the newest export is read (the notebook combines every file in its
  folder, where the Fabric installer keeps one), a file that isn't UTF-8 fails with a message saying
  so, and a column name longer than 128 characters can't be a SQL column, so it's dropped with a
  warning.
- **Turned off**, its columns stay in `copilot_org_data`, empty from the next publish.
- **Demo mode** doesn't load a Workday sample, and doesn't publish the preview.

| Table | Publish |
|---|---|
| `copilot_org_data` | snapshot, with the export's columns when the output is the org data |
| `copilot_org_data_workday_preview` | snapshot, only when the output is the preview |

There's no migration: publish creates the preview table and adds the export's columns to
`copilot_org_data`.

## Defender (module `defender`)

Optional and off by default. It mirrors `Copilot_Defender_Ingester.ipynb` on Fabric; both run
`valuelens_core.defender`. It reads advanced hunting through Microsoft Graph
`POST /security/runHuntingQuery` and Cloud Discovery through the Graph beta
`security/dataDiscovery/cloudAppDiscovery`, as the managed identity.

- **Each probe fails on its own.** Device activity, installed software, AI agents and Cloud
  Discovery each write a row to `defender_status` (`ok`, `empty`, `forbidden`, `unlicensed` or
  `error`). A probe that didn't answer keeps its last good data, and the run carries on. Only
  storage errors fail the step.
- **The watchlist** is `landing/defender/ai_watchlist.csv`. The first run writes the starting list
  there; edit it to add tools or set their posture. If it can't be read, the run uses the starting
  list and logs a warning.
- **First run** loads 29 days; later runs reload from the day before the last loaded day.

| Table | Publish |
|---|---|
| `defender_shadow_ai_daily`, `defender_shadow_ai_totals_daily` | by `Day` |
| `defender_ai_watchlist`, `defender_ai_installed`, `defender_cloud_discovery_ai`, `defender_ai_agents`, `defender_status` | snapshot |

`azure/sql/migrations/V003__defender.sql` creates them up front, so the model loads empty tables
until the first run.

## Agent Evaluator (module `agentEvaluator`)

Optional and off by default. The installer adds it to `VALUELENS_MODULES` when you tick Agent
Evaluator, outside demo mode, as on Fabric. It lists the environments you pick in
`VALUELENS_DATAVERSE_ENVIRONMENTS` only once the job's managed identity can read one of them. Until
then the list is empty, so the job reads no transcripts and leaves the `ae` model alone: see
[Agent Evaluator](../README.md#agent-evaluator). The module ports the Fabric notebook
`Copilot_Agent_Transcript_Parser.ipynb`. `collect/agent_evaluator.py` reads Copilot Studio conversation
transcripts from Dataverse, and `valuelens_jobs/transcripts.py` parses them into the notebook's seven
tables, with the same columns, so the Agent Evaluator model reads `dbo.<table>` in Azure SQL.
`tests/test_azure_agent_evaluator.py` checks the parser's rows against the notebook's own code.

- **Identity.** The job's managed identity reads `conversationtranscripts` in each environment of
  `VALUELENS_DATAVERSE_ENVIRONMENTS`, with a token for `<environment URL>/.default`. It needs to be an
  application user in each environment with the **Bot Transcript Viewer** role; a 401 or 403 says so
  in `evaluator_status`. UPNs that a transcript doesn't carry come from Graph `$batch` with
  `User.Read.All`, which core already grants. That lookup is best effort.
- **Reading.** Each environment's days are split into `VALUELENS_TRANSCRIPT_WINDOWS` date windows, read
  up to `VALUELENS_TRANSCRIPT_PARALLEL` at a time, in pages of `VALUELENS_TRANSCRIPT_PAGE_SIZE`.
  Throttling (HTTP 429, honouring `Retry-After`) and transient errors are retried. An environment
  without the bot lookup on transcripts is read without it. Up to four worker processes parse the
  pages as they arrive.
- **Incremental.** A run reads the last `VALUELENS_TRANSCRIPT_LOOKBACK_DAYS` (default 14), stretched to
  cover any gap since the environment's last complete read. An environment that no run has read
  completely goes back `VALUELENS_TRANSCRIPT_FIRST_READ_DAYS` (default 180). A transcript that's read
  again replaces all of its rows, and only the month files that changed are rewritten.
  `is_returning_user` and `agent_catalogue` are worked out again from the whole history. The merge
  takes one table at a time, and DuckDB keeps it within `VALUELENS_DUCKDB_MEMORY_LIMIT` (default
  `4GB`), spilling to disk past that.
- **Each environment fails on its own.** `evaluator_status` has one row per environment (`ok`,
  `empty`, `forbidden` or `error`) saying what it read. After a failed window, that environment's last
  complete read stays where it was, so the next run reads the window again. The step fails only when
  nothing could be read.
- **Privacy, as in Fabric.** The raw transcript is never written anywhere. Prompts, replies and error
  messages are kept as 500-character previews, and feedback comments as written. `user_id_hash` holds
  the user's Entra object ID, not a hash, so sessions join to org data. Parsed rows wait in a
  temporary folder on the job's own disk until the merge. The tables keep every transcript the job has
  read, also after Dataverse deletes it (by default, after 30 days).

| Table | Publish |
|---|---|
| `agent_sessions`, `agent_turns`, `agent_errors`, `agent_subagents`, `agent_performance` | by `transcript_date` |
| `agent_catalogue`, `evaluator_status` | snapshot |

`azure/sql/migrations/V008__agent_evaluator.sql` creates them up front. The five transcript tables add
`source_environment` (the environment URL) and `transcript_date` (the UTC day the conversation
started), and are clustered on `transcript_date`. As in every Azure table, text longer than 4,000
characters is cut to 4,000.

## Settings

The job reads its settings from environment variables. Bicep sets them.

| Variable | Meaning |
|---|---|
| `AZURE_CLIENT_ID` | The user-assigned managed identity the job runs as |
| `VALUELENS_TENANT_ID` | The customer tenant |
| `VALUELENS_STORAGE_ACCOUNT` | The ADLS Gen2 account (containers `raw`, `curated`, `landing`) |
| `VALUELENS_SQL_SERVER`, `VALUELENS_SQL_DATABASE` | The Azure SQL target. Auth is Entra-only, with an access token. |
| `VALUELENS_MODULES` | A comma list such as `core,orgData,m365Activity,agent365,productFeedback,consumption,defender,resourceGraph`. The default is `core,orgData`. The web app gets the same list and tells the app which modules are off. |
| `VALUELENS_ARG_MANAGEMENT_GROUP` | resourceGraph: the management group Resource Graph reads. Empty reads everything the identity can see. |
| `VALUELENS_ARG_AGENTS`, `VALUELENS_ARG_FOUNDRY` | resourceGraph: `false` turns off the agent or Foundry probes. Both default to `true`. |
| `VALUELENS_AZURE_AI_SUBSCRIPTION` | consumption: the subscription for Azure OpenAI / AI Foundry costs and metrics. When it is empty, Azure AI and pay-as-you-go are skipped. |
| `VALUELENS_PAYG_SUBSCRIPTIONS` | consumption: other subscriptions, as a comma list, whose Copilot pay-as-you-go costs are read |
| `VALUELENS_DROP_SITE_ID`, `VALUELENS_DROP_DRIVE_ID`, `VALUELENS_DROP_FOLDER` | consumption, agent365, productFeedback and workday, private networking: the SharePoint drop folder (see above). When unset, the job reads the `landing` container. |
| `VALUELENS_WORKDAY_MODE` | workday: `auto` (the default), `enrich` or `standalone`, as the notebook's `MODE` |
| `VALUELENS_WORKDAY_OUTPUT_TABLE`, `VALUELENS_WORKDAY_ALLOW_BASE_OVERWRITE` | workday: `dbo.copilot_org_data_workday_preview` (the default) or `dbo.copilot_org_data`, which needs the overwrite set to `true`. Bicep sets both from the installer, so a redeploy resets them. |
| `VALUELENS_WORKDAY_MIN_MATCH_RATE` | workday: the share of the export's people that must match the org data, from 0 to 1 (default 0.5) |
| `VALUELENS_WORKDAY_EMAIL_COLUMN` | workday: the export's work-email header (default `primaryWorkEmail`), matched ignoring case and spaces |
| `VALUELENS_DATAVERSE_ENVIRONMENTS` | agentEvaluator: the environments to read, as a JSON list of `{"url": ..., "name": ...}` or comma-separated URLs |
| `VALUELENS_TRANSCRIPT_LOOKBACK_DAYS` / `VALUELENS_TRANSCRIPT_FIRST_READ_DAYS` | agentEvaluator: the days each run reads again (default 14; 0 reads everything every run), and how far back an environment's first complete read goes (default 180) |
| `VALUELENS_TRANSCRIPT_WINDOWS`, `VALUELENS_TRANSCRIPT_PARALLEL`, `VALUELENS_TRANSCRIPT_PAGE_SIZE` | agentEvaluator: the date windows per environment (default 4), how many are read at once (default 4), and the page size (default 1000) |
| `VALUELENS_TRANSCRIPT_PARSE_WORKERS` | agentEvaluator: the parse processes. The default, -1, uses one per CPU up to four; 0 or 1 parses in the job's own process. |
| `VALUELENS_TRANSCRIPT_RESOLVE_UPNS` | agentEvaluator: `false` stops looking up UPNs in Graph for users whose transcripts don't carry one. The default is `true`. |
| `VALUELENS_AUDIT_HISTORY_DAYS` / `VALUELENS_AUDIT_LOOKBACK_DAYS` | The first-run backfill (default 30) and the re-read window on later runs (default 7) |
| `VALUELENS_PROCESS_LOOKBACK_DAYS` | Days before the newest audit record whose months `process` always recomputes (default 14) |
| `VALUELENS_PROCESS_FULL_REBUILD` | `true` makes `process` recompute every month. Set it on a single execution, not on the job. |
| `VALUELENS_DUCKDB_MEMORY_LIMIT` | Optional DuckDB memory cap, for example `4GB`, for `process` and the Agent Evaluator merge. Past it, DuckDB spills to the job's temporary folder. `process` has no cap by default; the Agent Evaluator merge uses `4GB`. |
| `VALUELENS_AUDIT_BACKFILL_DAYS` | A one-off reload of this many days of audit history, even after the first run. The installer sets it on a single execution when **Repair or change** loads more history; don't set it on the job itself, or every run reloads. |
| `VALUELENS_POWERBI_WORKSPACE_ID`, `VALUELENS_SEMANTIC_MODELS` | The Power BI workspace, and a JSON object of the models to refresh |
| `VALUELENS_SQL_READER_NAME`, `VALUELENS_SQL_READER_CLIENT_ID` | The web app's identity, granted read access by `migrate` |
| `VALUELENS_MIGRATIONS_DIR` | Where the migrations are. The image sets this to `/app/sql/migrations`. |
| `VALUELENS_SAMPLE_DATA` | Demo mode, set to `true` to turn it on. Collect loads the synthetic sample bundled at `/app/sample-data` into a temporary store instead of calling the tenant APIs, with its dates moved forward by whole weeks to end last week. Publish then replaces only the interactions, licensed and org tables. With `consumption` on, it also loads the synthetic Consumption Central sample from `/app/sample-data/consumption` (dates unchanged) and publishes the consumption tables. Remove the setting, and the next run republishes the tenant's data. |

## Storage layout

| Path | Contents |
|---|---|
| `raw/copilot_interactions_parsed/` | Flattened audit records, one parquet file per day |
| `raw/_audit_staging/`, `raw/_state/audit.json` | Audit queries that are still running, and the high-water mark |
| `raw/copilot_licensed_users/`, `raw/copilot_org_data/`, `raw/m365_activity_daily/` | Collector snapshots |
| `curated/copilot_interactions_curated/month-YYYYMM.parquet` | The curated fact, one file per month (`month-none` for rows without a date). Each file is written atomically. |
| `curated/_valuelens_process/` | process: the per-month source fingerprints (`state.json`) and the per-month context that incremental runs reuse |
| `curated/studio_*/`, `curated/viva_*/` | consumption: the merged Studio and Viva tables, rewritten atomically each run |
| `raw/azure_ai_*/`, `raw/copilot_payg_spend/`, `raw/azure_deployment_health/`, `raw/azure_solution_spend/`, `raw/azure_billing_reconciliation/` | consumption: Azure AI snapshots |
| `landing/studio/`, `landing/viva/` | consumption: the drop folder in public networking. It is read only. |
| `raw/agents_365/part-0.parquet` | agent365: the newest Agent 365 export, as landed |
| `landing/agent365/` | agent365: the drop folder for the export in public networking. It is read only. |
| `raw/user_feedback/part-0.parquet` | productFeedback: every product feedback export, deduplicated by `Feedback Id` |
| `landing/product_feedback/` | productFeedback: the drop folder for the exports in public networking. It is read only. |
| `raw/copilot_org_data_workday_preview/part-0.parquet` | workday: the enriched org data to review, when that's the output. Otherwise the export's columns are in `raw/copilot_org_data/`. |
| `landing/workday/` | workday: the drop folder for the export in public networking. It is read only. |
| `raw/defender_*/` | defender: one parquet file per day for the two daily tables, a snapshot for the rest |
| `landing/defender/ai_watchlist.csv` | defender: the AI watchlist. The first run writes it; after that it is only read |
| `raw/agent_sessions/month-YYYYMM.parquet` | agentEvaluator: one file per month the conversations started in (`month-none` without a start time), for each of the five transcript tables |
| `raw/agent_catalogue/`, `raw/evaluator_status/` | agentEvaluator: the agents seen in every session, and what the latest run read from each environment |
| `raw/_state/agent_evaluator.json` | agentEvaluator: when each environment was last read completely |

The SQL tables have the same names as the Fabric Lakehouse tables, so the ValueLens Model only
changes its connection parameters.

## Running locally

```powershell
pip install -r "azure/jobs/requirements.txt" -e core
$env:PYTHONPATH = "azure/jobs"
# Offline: a folder holding raw/copilot_interactions_parsed, raw/copilot_licensed_users, raw/agents_365
python -m valuelens_jobs process --data-dir .\data
python -m pytest tests/test_azure_jobs.py -q
```

To build the image, run `docker build` from the repo root, so that the shared core and the migrations are in the build context:

```powershell
docker build -f "azure/jobs/Dockerfile" -t valuelens-jobs:dev .
```

The `azure-images` workflow builds the image on pull requests. On `installer-v*` tags it publishes `ghcr.io/microsoft/valuelens-jobs:<installer version>`.

## Pitfalls

- **Concealed names in Microsoft 365 reports.** When the tenant hides user names in reports, the reports return hashes, which can't be joined to users. The m365 collector stops and says so. Turn off *Display concealed user, group, and site names in all reports* in Microsoft 365 admin center under Settings > Org settings > Reports.
- **Power BI API access for service principals.** Refresh needs the Fabric tenant setting *Service principals can call Fabric public APIs* to be enabled for a security group that contains the job's identity. That identity also needs to be a Member of the workspace.
- **Azure SQL serverless auto-pause.** The first connection after a pause can fail with error 40613. The job retries for about four and a half minutes.
- **Private networking login timeouts.** Behind a private endpoint, SQL's default Redirect policy can hang at login (`HYT00 Login timeout expired`), even though DNS and port 1433 work. The template sets the Proxy policy in private mode; check `az sql server conn-policy show` if you see this.
- **Hierarchical namespace.** The storage account is ADLS Gen2, so blob listings include directory placeholders (`hdi_isfolder`). The store skips them; deleting one fails with `DirectoryIsNotEmpty`.
- **Failed audit query windows.** Purview sometimes ends an audit query as `failed` or `cancelled` on large tenants. The audit collector works like the Fabric notebook: it sends the window again as a new query with a growing wait (`WINDOW_RETRIES`, default 3), then splits it in half down to `MIN_CHUNK_HOURS` (1h). After a failure or an HTTP 429, it runs fewer queries at once (`MAX_CONCURRENT_QUERIES`, default 5). Windows that finished are merged. While any window is still failing, the high-water mark doesn't move, the job exits with code 1 and lists the failed windows, and the next run queries only those again.
- **Audit Search throttling.** Graph allows only a few audit queries at a time per tenant, so a first load over a long look-back sees many 429s and can take an hour or more. Windows that still fail are kept as failed in the manifest and the next run picks them up.
- **Reading job logs.** `az containerapp job logs show -g <rg> -n <job> --execution <name> --container <migrate|run>` reads the console directly and works while Log Analytics ingestion is still catching up.
