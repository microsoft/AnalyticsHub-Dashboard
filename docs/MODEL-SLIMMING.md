# Model slimming for large tenants

This change reduces refresh-time calculations and high-cardinality imported data in the
ValueLens audit fact (`Chat + Agent Interactions (Audit Logs)`). Model-size and dashboard
latency improvements must be measured on the deployed build; source changes alone do not
establish those improvements.

- **31 DAX calculated columns.** VertiPaq builds these in memory after every import, several with
  per-thread or per-message `CALCULATE(..., ALLEXCEPT(...))` scans. These add refresh work
  and prevent using this fact table directly in Direct Lake.
- **Near-unique text columns.** `ThreadId`, `Message_Id` and the per-second `CreationDate` have
  almost one value per row, so their dictionaries were as large as the table.

This page describes what changed, the order to deploy it in, and how to rebuild and check the
templates.

## What changed

### ValueLens (`ValueLens - Fabric.pbit`, `ValueLens - Fabric OneLake.pbit`)

| Before | After |
|---|---|
| 24 calculated columns the report reads (`Is_Cowork`, `AppHost_Norm`, `Agent Filter (Normalized)`, `Session Turn Band` and its sort, `Model Cost Tier` and its sort, `Work Weight Grade` and its sort, `Session Material Refs`, `Session Material Types`, `Cowork Task Category`, `Task Breakdown Category`, `Is Prompt Row`, `Is Observed Prompt`, `Task Engagement Mode`, `Task Breakdown Group`, `Fit Basis`, `Work Shape` and its sort, `Session Model Tier` and its sort, `Expertise Role (All Cohorts)`, `Is Usage Row`) | Imported data columns written by the processor. Name, type, lineage tag, sort-by, visibility and description are unchanged, so every visual and measure binds as before |
| 7 helper calculated columns (`Session Type Blob`, `Session Surfaces`, `Session Surface List`, `Session Build Artifact`, `Session Message Reads`, `Is Material Ref`, `Fit Rule Step`) | Removed. Only the columns above read them |
| `ThreadId`, `Message_Id`: the id text | Same names, now hidden whole-number columns bound to the processor's `Thread_Key` and `Message_Key`. Validate distinct counts and grouping equality before switching models; key assumptions are below |
| `CreationDate` (date and time) | Removed. The `Calendar` table and the agent last-activity measures read `InteractionDate`, the same day |

The fact table now has 0 calculated columns. The query still filters on `CreationDate` for
incremental refresh (12 months kept, the last 7 days refreshed), then drops it, `ThreadId` and
`Message_Id` before import. The partition's M and the refresh policy's source expression are the
same.

### Processor

The notebook `Copilot_Audit_Log_Processor` (section 10c), its DuckDB twin
`core/valuelens_core/processor.py` (`_slim`, `SLIM_COLS`) and the Azure process job all write the 24
columns plus `Thread_Key` and `Message_Key` to `copilot_interactions_curated`. The logic ports the
original DAX: comparisons ignore case, `TRIM` collapses runs of inner spaces, and `ALLEXCEPT` groups
by the id value ignoring case, with blank as its own group. `tests/test_model_slimming.py` holds an
independent reference written from the original DAX. This is an offline contract test, not
execution of the old DAX engine. The golden fixtures (`tests/valuelens_golden.py`) compare
DuckDB with recorded Spark output; the optional Spark check executes the notebook again. On Azure,
`azure/sql/migrations/V007__model_slimming.sql` adds the columns to the SQL table.

### Agent Evaluator (`Agent Evaluator.pbit`)

`scripts/Update-Model-Refresh-Fixes.py` drops five calculated columns that nothing reads: no
measure, sort-by, hierarchy, relationship or report visual. They are
`Knowledge Citations[Topic (conversation)]`, which ran a `FILTER(ALL('Activity Events'))` per
citation, `Activity Events[Topic + Action]`, `Activity Events[Topic + Category]`,
`Agent Performance[ConversationComplexity]` and `Agent Turns[From]`. The earlier fix for
`Agent Turns[Response Seconds]` is unchanged. The Metric Glossary sort-by fix
(`Update-Glossary-Sort-Order.py`) was already in place.

## Deploy order

1. **Update the processor**, on Fabric (`Repair or change`) or Azure (the jobs image, which runs
   migration V007).
2. **Rebuild every curated month once.** On Fabric use `WRITE_MODE = "overwrite"`; on Azure use
   `python -m valuelens_jobs process --full-rebuild`, then publish. Processor logic version 2
   (Fabric) and the changed core fingerprint (Azure) also force this migration automatically.
   Check column types, nonblank required values, key mappings and row counts before continuing.
3. **Deploy and refresh all partitions of the updated model**, then run paired old/new DAX
   equality checks on the same data. Do not rely on the ordinary seven-day refresh window.
4. **Deploy the app only after data and model readiness checks pass.**

Missing processed columns are added as typed nulls by the model's M as a transitional compatibility
guard. Successful refresh with these placeholders is **not readiness or correctness**: counts or
classifications can be blank or wrong. Do not switch users to that model. Existing models can read
the enriched table because the original source columns remain available.

**Subsequent runs stay incremental.** Changed source months and the 14-day lookback are rebuilt.
The previous and replacement rows identify affected thread/message keys, including deleted or
changed IDs. Their groups are recalculated with complete retained history. Historical rows receive
only the affected conversation columns; licence/registry snapshots and unrelated group values stay
unchanged. Additional months are rewritten only when their conversation values actually change.
Null IDs form a group, matching the existing calculation contract, so a changed null-ID group can
legitimately affect several months. This is not an approximation or a fixed lookback for threads.

**Fabric materialization.** Incremental conversation updates write and reread run-owned Parquet
snapshots in `Files/_valuelens_conversations/<run-uuid>/` in the **output table's** lakehouse.
The processor derives its shared ABFSS path from `DESCRIBE DETAIL OUT_TABLE`, supporting both
`Tables/<table>` and `Tables/<schema>/<table>` locations, including custom output tables. Other
locations fail explicitly; there is no fallback to driver-local storage or the default lakehouse.
The run identity needs write/delete access to that lakehouse's `Files` area as well as the table.
Full rebuilds and unchanged runs need no conversation staging.
This materialization fix does not change curated values or column types, so processor logic
version 2 is retained and no additional one-time full rebuild is required.

These snapshots sever source/target lineage before Delta replacement and remain readable after
executor cache loss. Executor-local checkpoints and `persist` plus `count` are not substitutes:
the former can lose their only copy, and the latter can recompute against replaced source files.
No shared dynamic-allocation or Spark checkpoint-directory settings are changed. Snapshots live
through historical-change detection, the atomic Delta write and refresh/state marking; no staged
frame is returned from publishing. Normal success/failure removes only that run's UUID directory,
including partial writes. A retry uses fresh paths. Cleanup errors are reported. A terminated
driver can leave an orphan directory: remove only its specific run directory after confirming that
the run and all readers have ended, never the staging root or another active run's files.

If older curated dates changed, refresh historical semantic-model partitions, not only the recent
refresh window. Azure's publish fingerprint and refresh logic request an all-partition refresh for
older changed days. On Fabric, the processor compares old-day output fingerprints and records a
durable `valuelens.audit_data_version` table property when needed. Before replacing an existing
table's data it saves a separate `valuelens.audit_refresh_intent` property: a unique intent ID,
the source months to recompute, and the expanded historical write coverage. This preparation is
**not** a generation that a refresh may acknowledge. Only after the atomic Delta write succeeds
does one atomic table-property update publish a fresh ready generation, advance source state and
record `valuelens.audit_refresh_completed_intent`. It does not clear the prepared property;
an intent whose ID differs from the completed ID remains unfinished.

If publication fails after the data commit, a retry still requests historical refresh even when
the rewritten data now compares equal or a dependency month no longer needs rewriting. It replays
the original source months, including when their fingerprints revert, but not dependency-only
months from parsed source: those keep their licence/registry snapshots through the conversation
history update. Invalid intent fails explicitly rather than being discarded. First table creation
cannot save a property before the table exists; missing processor state is its durable full-replay
sentinel until ready generation and state are published together. An existing model can refresh
during that gap, but there is no new generation to acknowledge; successful producer retry still
publishes a pending generation. Legacy or manually populated tables without processor state are
not automatically certified by a model refresh: the next processor run performs a full rebuild.
Unchanged runs and current-window rewrites with no old-day changes do not rotate the generation.

**Serialize processor runs for each output table.** The data overwrite and source-state protocol
do not provide a multi-producer lock. Delayed finalization records only its captured intent ID and
cannot erase a newer prepared intent, but this is not a guarantee for overlapping producers'
source snapshots, preparation or data writes. Model refreshes may overlap processing safely with
respect to generation acknowledgement: they capture only committed tokens, before SQL endpoint
synchronization, and never resolve an in-flight preparation.

The updated pipeline enables
`CHECK_AUDIT_STATE` on the ValueLens refresh notebook (not Consumption Central or Agent Evaluator).
It refreshes every audit partition and acknowledges that generation for that model only after
success, even when the service history looks like a first refresh. A failed refresh leaves it
pending; a newer concurrent processor generation cannot be cleared by an older refresh. By-hand
installations must update both processor and refresh notebooks and enable `CHECK_AUDIT_STATE`
with the correct default lakehouse, or explicitly refresh all historical partitions.
This correction does not recover already-lost markers from older processor runs. Recovery requires
separately verified all-audit-partition model refresh and historical metric checks after processing
is reconciled; an ordinary incremental retry or `WRITE_MODE` setting alone is not evidence of recovery.

`tests/test_historical_refresh_intent.py` executes the notebook's planner, publisher, Delta writer
ordering and refresh consumer with injected storage. It covers failures before/after data and
property commits, first creation, source fingerprint reversion, retained dependency snapshots,
concurrent acknowledgement, per-model generations and unchanged tokens. These are offline
control-flow tests, not positive live Fabric durability or performance evidence.

`tests/test_conversation_incremental.py` covers append, ID changes, deletion, independent months,
snapshot preservation and full-rebuild equality on Azure/DuckDB and the Spark notebook functions.
`tests/conversation_parity.py` is also runnable with `run_spark(spark)` on Fabric using temporary
parsed-input views. It performs no production writes. Delta replacement and live DAX are separate
checks. The fixture's `run_materialization_regression(spark)` first reproduces the unsafe
local-checkpoint failure by removing only its own checkpoint RDD. It then evicts its own cached input/output,
replaces its source files, checks the original snapshot plus nullable/complex schemas and empty
frames, and confirms cleanup cannot remove another active run's snapshot. Both routines clean
their own temporary Parquet files (`Files/_valuelens_conversation_tests` on Fabric); neither
disables dynamic allocation nor clears other sessions' caches.
A generator that supplies curated tables directly cannot validate the parsing pipeline:
use the parsed fixture for that check and verify input coverage before backfilling model columns.

## The integer keys

`Thread_Key` and `Message_Key` are the first 60 bits of `md5(lower(id))`, as a signed 64-bit
integer. A null id gives a null key and an empty id gives a non-null key, so blank and empty stay
apart, as they were in the text column. Spark, DuckDB and Azure compute the same values (the golden fixtures pin
this).

- **No trim.** The recovered key contract hashes the case-folded source value without trimming.
  Before migration, check that IDs have no trailing spaces and that the old model's distinct
  counts match the new keys. A discrepancy blocks the model switch; do not assume GUID-like
  values establish equality for every source.
- **Collisions.** Two distinct ids collide with probability about n² / 2⁶¹. At 100 million prompts
  that is roughly 0.4% for the whole table, and a collision makes one distinct count one lower. At
  10 million sessions it is about 0.004%. Check the source-ID-to-key mapping for collisions and
  compare old/new DAX counts before switching. Do not accept differing totals as a tolerance.
- Don't show the keys. They're hidden and described in the model.

## Rebuilding the templates

The `.pbit` files are patched in place by scripts. Run them in this order and make sure both report
every template as current:

```powershell
python scripts/Update-Model-Slimming.py            # ValueLens: slim the fact table
python scripts/Update-Template-Dax.py              # ValueLens: Calendar and usage measures
python scripts/Update-Model-Refresh-Fixes.py       # Agent Evaluator and Consumption Central
python scripts/Update-Model-Slimming.py --check    # each --check exits 1 if a template is stale
python scripts/Update-Template-Dax.py --check
python scripts/Update-Model-Refresh-Fixes.py --check
python scripts/Update-Glossary-Sort-Order.py --check
python -m pytest tests                             # includes the model and oracle tests
```

`tests/test_consolidated_release.py` pins the hash of each shipped ValueLens template, so update
the pins after a deliberate rebuild.

## Desktop refresh checks

There's no VertiPaq engine in CI, so check a rebuilt template in Power BI Desktop (June 2024 or
later) against a lakehouse that the new processor has written:

1. Open the `.pbit`, enter the workspace and lakehouse, and let it refresh. It should finish with no
   calculated-column step on the audit fact.
2. In **Model view**, the audit fact should show no calculated columns, and `ThreadId` and
   `Message_Id` should be hidden whole numbers.
3. Compare headline numbers with the previous template on the same data. Run this DAX query in
   both and diff the results:

   ```dax
   EVALUATE
   ROW(
       "Users", DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Audit_UserId]),
       "Sessions", [Observed Sessions],
       "Prompts", DISTINCTCOUNT('Chat + Agent Interactions (Audit Logs)'[Message_Id]),
       "Usage rows", CALCULATE(COUNTROWS('Chat + Agent Interactions (Audit Logs)'),
           'Chat + Agent Interactions (Audit Logs)'[Is Usage Row] = TRUE()),
       "First day", MIN('Calendar'[Date]),
       "Last day", MAX('Calendar'[Date])
   )
   ```

   Then group by each of the 24 columns, for example
   `SUMMARIZECOLUMNS('Chat + Agent Interactions (Audit Logs)'[Work Shape], "Rows", COUNTROWS('Chat + Agent Interactions (Audit Logs)'))`.
   The two templates should give the same answers. The Calendar range is the same, because the
   processor writes `InteractionDate` as the date part of `CreationDate`.
4. Check the missing-column compatibility path separately. Refresh can succeed with typed-null
   placeholders, but that model must remain unavailable to users until the required data is populated.
5. Check the model size (**Settings → Semantic model → Size**, or VertiPaq Analyzer) against the
   old template.

## Follow-ups not in this change

- **Report rank measures.** Some report-only rank measures still re-rank every user for each user
  shown, so their cost grows with the square of the user count. The app no longer calls them (it
  ranks inside its own queries), but report pages that show them stay slow at 30–40k users. The fix
  is a per-user-per-month table the processor writes.
- **Agent Evaluator imported columns.** `FirstBotMessage`, `LastBotMessage`, `AllVariables`,
  `content_preview`, `error_message` and the `Var_ESS_*` columns are imported but unused. Dropping
  them means editing the M in both the model and its unapplied changes.
- **Consumption Central calculated columns.** 19 calculated columns. The costly ones are
  `CoworkBilling[UsageCohort]` and `[UsageCohortRank]` (`RANKX(ALL('CoworkBilling'), ...)` per row,
  so the cost grows with the square of the rows), `CoworkBilling[Weeks Over Limit]`
  (`FILTER(ALL('CreditsWeekly'))` per user) and `CreditsWeekly[Weeks Ago]`. Move them into the
  credit ingester, or rewrite `Weeks Over Limit` with `CALCULATETABLE`.
- **Direct Lake.** The ValueLens fact table is now eligible. Other tables in the model still have
  calculated columns or Power Query steps.
