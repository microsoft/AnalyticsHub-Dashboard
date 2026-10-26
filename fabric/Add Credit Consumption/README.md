# ➕ Add Credit Consumption — Fabric

**Optional.** A second, separate Power BI report — **Consumption Central** — covering Copilot
credit consumption and cost across **Cowork / Work IQ**, **Copilot Studio**, **GitHub Copilot** and
**Azure AI Foundry**. ValueLens shows adoption and value; this shows what it costs. Skip it and
nothing in ValueLens changes.

You can use the **same Lakehouse as ValueLens**. Its table names and `Files/landing/` folders don't
overlap with anything ValueLens reads or writes. Load only the products you have; the other pages
stay empty.

> **Using the [Fabric installer](../../installer/README.md#credit-consumption)?** On its **Data
> sources** screen, **Credit consumption** is three cards: **Copilot Studio credits**, **Copilot
> Cowork credits** and **Azure AI costs**. Choose the ones you want. The installer sets up the
> notebooks, the upload folders, the semantic model and the app's Consumption pages for you. For
> **Copilot Studio credits** it creates the Power Automate flow, and you
> [sign in to its connections](../../installer/README.md#power-automate-flows) once. For **Copilot
> Cowork credits** it creates the Dataflow from the Viva Insights query
> ([step 1](#viva-dataflow)): it fills in the partition ID with your tenant ID, and if you don't
> have the query yet you can add the query later. Ask your Viva Insights analyst for it
> [before you start](../../docs/PREREQUISITES.md#send-this-to-your-viva-insights-analyst-first).

### What's here

| Item | Purpose |
|---|---|
| `Consumption Central - Fabric.pbit` | The report, reading the Lakehouse SQL analytics endpoint. |
| [`../notebooks/credit-consumption/`](../notebooks/credit-consumption/) | One ingestion notebook per product. Import only the ones you need. |
| [`seed_sample_data.py`](seed_sample_data.py) | Loads the synthetic sample into your Lakehouse. It writes Consumption Central tables only. |
| [`DATA-DICTIONARY.md`](DATA-DICTIONARY.md) | Every table and column the report expects. |

---

## 🛠 Setup

<a id="viva-dataflow"></a>

### 1. Land Cowork data with a Dataflow

The [installer](../../installer/README.md#credit-consumption) does this for you when you set the
**Copilot Cowork credits** card to **Connected (Dataflow)**, except signing in to the Dataflow's
connections, which only you can do:

- Open `AnalyticsHub_Cowork_Credits` (the **Done** page links to it). It shows **Configure
  connection** twice, once for the Viva Insights source and once for the Lakehouse destination.
  On each, choose **Configure connection**, sign in, then **Connect**.
- Choose **Save** and wait until the Dataflow shows it has finished publishing. Until then a
  refresh fails with *Job instance failed without detail error*, which the installer reports as
  *Needs sign-in*.
- Choose **Load Cowork now** in the installer, or run `load-cowork`. It refreshes the Dataflow,
  runs `Ingest_Viva_Consumption` and the consumption model refresh, and says how many rows loaded.

If the Dataflow isn't signed in when the installer's first load starts, that run leaves it out
(`SkipCowork=true`) and the **Done** page shows *To do: sign in to the Cowork Dataflow*. Scheduled
runs never skip it. The staging items Fabric adds for Dataflows are expected; see below.

By hand:

1. Viva Insights → **Create analysis** → **Create custom query** → **Consumption query** → turn on
   **Auto-refresh** → **Run** → **Analysis results** → **link icon** → copy the **Partition** and
   **Query** identifiers. You need the **Insights Analyst** role. The partition ID is usually your
   tenant ID. [Step by step](../../docs/VIVA-QUERY.md)
2. Fabric workspace → **New** → **Dataflow Gen2** → **Get data** → **Viva Insights**. Paste both
   identifiers and leave *Query Name* blank. Under **Advanced options** set **Schema Type = Pivoted** and
   **Data Granularity = Row-level data**.
3. Set the destination to your Lakehouse, table **`viva_credits_dataflow`**, replacing its data
   each refresh. Keep the person identifiers and employee attributes; department views are built
   from them. Schedule it for **Tuesday morning**, after Viva's weekend refresh, and run
   `Ingest_Viva_Consumption` after it. The notebook merges the Dataflow's rows into
   `viva_credits_weekly`, so history builds up past Viva's six-month window.

A Dataflow you set up earlier that writes straight to `viva_credits_weekly` still works, as long
as you don't also run `Ingest_Viva_Consumption`.

Fabric adds **DataflowsStagingLakehouse** and **DataflowsStagingWarehouse** items to the workspace
for Dataflows. They're expected: leave them.

[Microsoft's guide ↗](https://learn.microsoft.com/en-us/viva/insights/advanced/analyst/export-query-data-microsoft-fabric)

### 2. Import the notebooks for your other products

Set the workspace and Lakehouse at the top of each notebook, then run it.

| Notebook | Reads | Writes |
|---|---|---|
| `Ingest_Studio` | The licensing API flow's files and any Power Platform admin centre exports in `Files/landing/studio/` and its `backfill/<YYYY-MM>/` folders | `studio_*` |
| `Ingest_GitHub_API` | GitHub REST API *(preferred: runs unattended)* | `github_*` |
| `Ingest_GitHub` | The emailed AI usage report in `Files/landing/github/` | `github_*` |
| `Ingest_Azure_AI` | Azure Cost Management, Monitor, ARM and the public Retail Prices API ([setup ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/ADVANCED-SETUP.md#azure-ingestion-in-fabric)) | `azure_ai_spend`, `azure_ai_tokens`, and `copilot_payg_spend` for Copilot Studio and Cowork pay-as-you-go billed in Azure; then, best-effort, `azure_deployment_health`, `azure_solution_spend` and `azure_billing_reconciliation` ([details](DATA-DICTIONARY.md#azure-capacity-solution-spend-and-reconciliation)) |
| `Ingest_CommercialTerms` | Your negotiated rates *(optional; the [Fabric App](../../app/README.md#settings-in-the-app) can also take them)* | `commercial_terms` |
| `Ingest_Org` | Viva attributes, optionally overridden by files in `Files/landing/org/` | `org_attributes` |
| `Ingest_Viva_Consumption` | The Dataflow's `viva_credits_dataflow` table, and Viva CSV exports in `Files/landing/viva/`. For weeks both cover, the Dataflow wins | `viva_credits_weekly`, `viva_spending_policy` |

### 3. Open the template

Lakehouse → **Settings** → **SQL analytics endpoint** → copy the connection string. Open
**`Consumption Central - Fabric.pbit`** and fill in:

| Parameter | Value |
|---|---|
| `FabricSQLEndpoint` | The connection string you copied |
| `LakehouseName` | Your Lakehouse name |

### 4. Publish and schedule

Publish to your workspace. Schedule the report's refresh **after** ingestion succeeds. A Power BI
refresh does not run the notebooks.

---

## 🧪 Try it with sample data first

```
pip install pandas deltalake requests
az login --tenant <your-tenant>
python seed_sample_data.py --workspace <workspace-guid> --lakehouse <lakehouse-guid>
```

Both GUIDs are in the Fabric portal URL when the Lakehouse is open. The script reads the CSVs from
[`samples/consumption/`](../../samples/consumption/).
It writes to the `dbo` schema; add `--schema=` if your Lakehouse was created without schemas.

> **Per-person and department views** need Viva Insights **Identification** turned on
> ([how ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot#viva-identification)).
> Cowork totals are correct without it.

---

## 📚 Reference

- [How to read the report ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/INTERPRETING.md)
- [Where each export comes from ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/DATA-SOURCES.md)
- [Advanced setup: Azure auth, scheduling ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot/blob/main/docs/ADVANCED-SETUP.md)

The upstream `Ingest_Studio_Consumption` notebook isn't included. It needs a delegated sign-in, so it
can't run on a Fabric schedule. Instead, the installer creates a Power Automate flow,
`Analytics Hub - Copilot Studio credits`, that calls the same Power Platform licensing API each day
as an admin and saves `StudioApiAgentDaily_*.csv`, `StudioApiUserDaily_*.csv` and
`StudioApiEntitlement_*.csv` for `Ingest_Studio`. It's the default source for Studio credits; the
PPAC exports are optional and win for the months they cover. Each run replaces the API rows for
the days and months the flow's files cover, in one Delta commit per table: a failed write leaves
the table as it was, and days and months the files don't cover keep their rows. See the
[installer's flows](../../installer/README.md#power-automate-flows).

The per-agent and per-user exports carry no date: they're month to date. So each counts as the
month, in UTC, that its file arrived in `Files/landing/studio/`, kept as `snapshot_month`. A newer
export in the same month updates that month's rows, and one saved the next month adds a month. A
file left in the folder keeps its own month on later runs, so it never becomes a later month's.
Exports sent to the installer's drop folder or SharePoint get there when the upload router next
runs, early in the pipeline and before `Ingest_Studio`, so they count as the month of that run. The
router copies each one to the top of the folder, and moves earlier files of the same kind to
`_loaded/`, which `Ingest_Studio` doesn't read.

**Loading an earlier month's export.** In the Lakehouse, create
`Files/landing/studio/backfill/<YYYY-MM>/`, the folder for the month the export covers, and upload
the file there, not to the drop folder: the router ignores subfolders. Last month's export
downloaded on the 1st goes in last month's folder, for example. A file there counts as the folder's
month on every run, so there's nothing to move or reset afterwards. Do the same for an export sent
on a month's last day, which may not be routed until the next month. A tenant daily export keeps
its own dates wherever it sits.

**When `Ingest_Studio` stops before writing.** It stops, and lists the paths, if `backfill/` holds a
file outside a month folder, a folder whose name isn't `YYYY-MM`, or a month later than the current
one. A folder inside a month folder isn't read, and the run says so. The notebook's old
`SNAPSHOT_MONTH` setting is retired: a run with it still set stops, and points to the backfill
folder, whether it's set in the settings cell or passed to the notebook as a parameter (a pipeline
Notebook activity's base parameters, or the arguments of `notebookutils.notebook.run`). Either way,
the Studio tables keep their rows. In the installer's pipeline, the load fails after its retries
and the other loads still run, but the pipeline run fails, and the consumption model isn't
refreshed until a run succeeds. Move or remove what the message lists, or remove `SNAPSHOT_MONTH`,
then run the pipeline again or wait for the next run.

**Updating from an earlier version.** Earlier versions gave a per-agent or per-user export the month
of each run that read it, so an export left in `Files/landing/studio/` was stored again as each
later month's snapshot in `studio_agent` and `studio_user`. Updating leaves those copies in place,
and each month that holds one stays covered by an export: the current month too, if an earlier
version has already run this month with an older export in the folder. With the flow, the run prints
"an export covers this month, so the API figures aren't used" for such a month (in `studio_user`,
"…so the API user figures aren't used") and keeps the flow's figures out of it. That month's own
export replaces the copied rows it matches on the table's key: upload it as usual for the current
month, or for an earlier one, create its `backfill/<YYYY-MM>/` folder in the Lakehouse and upload it
there, as above. A copied row it has no match for, such as an agent it doesn't list, stays.

Copied from [microsoft/ConsumptionCentral-for-Microsoft-Copilot ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot)
(MIT) at commit `24b0ca8`. Full documentation and issues live there.
