# Running the Viva Insights query

**Copilot Cowork credits** come from a Viva Insights **consumption query** when the installer's
**Copilot Cowork credits** card is set to **Connected (Dataflow)**, or when you
[set it up by hand](../fabric/Add%20Credit%20Consumption/README.md#viva-dataflow). A Viva Insights
analyst builds the query once and turns on auto-refresh. The installer, or you, then gives its two
IDs to the `AnalyticsHub_Cowork_Credits` Dataflow. This page is the whole procedure.

No query? Cowork credits fall back to the Copilot Consumption Dashboard's CSV
[export](../installer/README.md#data-sources-and-exports). On Azure there's no Dataflow yet, so the
export is the only route there: drop it in the `viva` folder. See [Azure](../azure/README.md).

> **Build the query under Create analysis, not from the Consumption Dashboard.** The dashboard's
> **Connect data** dialog also hands out IDs, but they point at a multi-table result. The Dataflow
> reads a single table, and fails with those IDs.

## Before you start

| | |
|---|---|
| **Role** | Viva Insights [Insights Analyst](https://learn.microsoft.com/viva/insights/advanced/setup-maint/assign-user-roles) |
| **Per-person and department views** *(optional)* | Turn on Viva Insights **Identification** ([how ↗](https://github.com/microsoft/ConsumptionCentral-for-Microsoft-Copilot#viva-identification)) **before** you run the query. It takes up to 24 hours, and results produced before then keep hashed IDs |

Not the analyst yourself? Send them
[this note](PREREQUISITES.md#send-this-to-your-viva-insights-analyst-first) and a link to this page.

## 1. Create the query

[Viva Insights](https://analysis.insights.viva.office.com/) → **Create analysis** → **Create
custom query** → **Consumption query**.

Under **Query setup**:

| Setting | Set to | Why |
|---|---|---|
| **Name** | Something findable, like `AnalyticsHub_Cowork_Weekly` | You look for it in **Analysis results** |
| **Time period** | The longest **rolling** period offered, not a custom date range | A fixed range never moves forward, so auto-refresh has nothing new to fetch |
| **Auto-Refresh** | **On** | Without it the Dataflow reads the same result on every run |
| **More settings** > **Group by** | **Week**, the default | The Consumption pages are weekly |

## 2. Keep the preselected metrics

The consumption query adds four metrics for you. Keep all four: **Total Copilot Credits used**,
**Session count**, **User limit** and **Spending policy limit**.

Don't add a GitHub Copilot credit metric if your tenant offers one. It makes the query fail in
Viva Insights. GitHub Copilot credits come from GitHub instead: see
[Add Credit Consumption](../fabric/Add%20Credit%20Consumption/README.md).

## 3. Leave the population unfiltered

Add **no conditions**. Filtering by organisation or service here makes the Consumption pages
disagree with your bill. Filter in the app instead.

## 4. Add the attributes to group by (optional)

**Select attributes** → tick the employee attributes you want to group by, like Organization,
Function, Level or Region → **Add to query**.

Ticking them doesn't guarantee they come back. After the first load, check the department
filters on the Consumption pages. Where they're empty, `Ingest_Org` can take them from a
directory file instead: see [Add Credit Consumption](../fabric/Add%20Credit%20Consumption/README.md#2-import-the-notebooks-for-your-other-products).

## 5. Run it

Select **Run**, top right. In **Analysis results** the query shows **Running**, then **Success**.
Nothing can read it until it reaches **Success**.

## 6. Copy the two IDs

**Analysis results** → your query → the **link icon** → copy the **Partition identifier** and the
**Query identifier**. The partition ID is usually your tenant ID.

## 7. Give them to Analytics Hub

| How you install | Where the IDs go |
|---|---|
| **Installer** | **Copilot Cowork credits** card → **Connected (Dataflow)**. The partition ID is filled in with your tenant ID; paste the query ID. Already installed? Open the installer and choose **Repair or change**. From the command line: `install --data coworkCredits=api --viva-partition <id> --viva-query <id>` |
| **By hand** | A Dataflow Gen2 with the Viva Insights connector, writing to `viva_credits_dataflow`. See [Land Cowork data with a Dataflow](../fabric/Add%20Credit%20Consumption/README.md#viva-dataflow) |

Either way, someone then signs in to the Dataflow's two connections once. See
[Credit consumption](../installer/README.md#credit-consumption).

Building it by hand? In the Viva Insights connector leave **Query Name** and **Table name**
blank, set **Schema Type** to **Pivoted** and **Data Granularity** to **Row-level data**, and sign
in with an **Organizational account**.

**Policy names** don't come through the connector. To show them, upload the Consumption
Dashboard's `SpendingPolicyMetadata` CSV as an
[export](../installer/README.md#data-sources-and-exports).

## Keeping it running

- **Viva refreshes over the weekend.** The pipeline refreshes the Dataflow before each Viva load.
  Running it by hand? Schedule the Dataflow for **Tuesday morning**, around 8 a.m. PST.
- **Only the analyst who ran the query can edit, rename or delete it.** If they leave or lose the
  role, another analyst **clones** it, runs the clone with auto-refresh on, and you give the
  clone's IDs to the installer with **Repair or change**.
- **After changing a query**, check the link icon again, and update the IDs if they've changed.
- **Using Privileged Identity Management?** The Insights Analyst role might need re-elevating, and
  the Dataflow's connection signing in again, before scheduled runs succeed.

## If it goes wrong

| What you see | Cause | Fix |
|---|---|---|
| No link icon | The query hasn't reached **Success** | Wait, or rerun it from **More options** |
| Query status **Failed** | Usually a GitHub Copilot credit metric in the query | Remove it and rerun |
| Dataflow fails on the Viva Insights source | IDs from the Consumption Dashboard's **Connect data** dialog | Build a consumption query under **Create analysis** and use its IDs |
| `Refresh_Cowork_Credits` fails, or *Needs sign-in* | The Dataflow's connections aren't signed in, or it hadn't finished publishing | See [Troubleshooting](TROUBLESHOOTING.md) |
| Runs succeed but the latest week never appears | Auto-refresh is off, or the time period is a fixed range | Turn on **Auto-refresh** in **Analysis results**, and use a rolling period |
| Hashed person IDs, no names | Identification is off, or the query ran before it took effect | Turn it on, wait up to 24 hours, and rerun the query |

Microsoft's guides:
[Create a custom consumption query](https://learn.microsoft.com/viva/insights/advanced/analyst/ai-cost-query),
[Analysis results](https://learn.microsoft.com/viva/insights/advanced/analyst/query-results) and
[Export query data to Microsoft Fabric](https://learn.microsoft.com/viva/insights/advanced/analyst/export-query-data-microsoft-fabric).
