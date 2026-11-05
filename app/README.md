# DataHub App

The ValueLens dashboard as a web app in your Fabric workspace. The [installer](../installer/README.md)
deploys it for you. Use this folder only to deploy it by hand or to change it.

The app keeps no copy of your data. Each page queries the semantic model live, as the person
viewing it, so row-level security applies. How each figure is worked out is in the
[methodology](../docs/METHODOLOGY.md).

## Static browser demo

The standalone DataHub App browser demo at `demo.html` uses the real app screens with the published
[synthetic sample CSVs](../samples/README.md). It does not read host configuration, ask you to sign in, or contact a model or app
backend. Ask returns a local example answer; settings changes stay in memory for the current page
session, and admin-only actions are disabled.

The demo data build needs Python 3.10+ and the existing [core](../core/pyproject.toml)
DuckDB dependency (`python -m pip install -e ..\core` from this folder).
From this folder, install the app dependencies with `npm ci` and run:

```powershell
npm run build:demo
```

The build first runs `npm run demo:data`: CSV parsing and the shared core classifier produce
the ignored `src/demo/sample-data.generated.json`. The classifier's ingestion exclusions are
disabled because this is an already-curated published sample set: all 13,337 rows are retained.
Dates are not shifted. Reference task times, behavior mappings and glossary entries come from
the checked-in ValueLens template; default commercial terms are read, without executing it,
from the checked-in consumption sample seeder. Tests regenerate the data first. For a direct
typecheck or watch session, run `npm run demo:data` first.

The original activity dates are **1 June–31 August 2026**, with **170 inventory people,
13,337 tasks and 2,476.65 typical expert-equivalent hours** under the shipped template rules.
The dated consumption exports total **162,222.8531 credits**: 44,750.8531 Cowork and 117,472
Studio. These do **not** reproduce a separately transformed live installation's 2,690 hours
or 153.3k credits. User snapshots (117,475 Studio credits) and agent/feature snapshots retain
their own export grain; they are not rescaled to make dated tenant totals match. The consumption
directory and interaction sample use separate synthetic cohorts, so they are not joined by
invented identities. No live lakehouse data or private configuration is used.
The CSV inputs are unchanged from public sample commit
`b9c543d65ecfd406a8d74b33043fd5ff6162097c`
(sample tree `8280b20447058886574903d87976da40edc809bb`).

The completeness fixes replace query-hash numbers with native-schema adapters for Cowork/model
fit, activity/adoption, leaderboards, readiness, value, consumption, feedback and registry
governance. Percentages, rollup flags, full-list counts and concentration curves derive from
source rows. Unknown queries fail visibly rather than receive plausible invented values.
The public sample pack does not include Microsoft 365 telemetry, evaluation conversations,
Defender findings or Resource Graph configuration; those pages explicitly disclose unavailable
sources. Unset monthly budgets remain unset and can be tried in memory. Registry checks use
only the evidence present in the sample; unavailable authentication checks are not reported clear.

The self-contained static bundle is written to `dist-demo`. Serve that directory from any static
file host; `index.html`, its local assets, the MIT `LICENSE.txt`, and the generated
`THIRD_PARTY_NOTICES.txt`, `SOURCE_PROVENANCE.json` and `SHA256SUMS.txt` travel together.
Provenance records the source revision, sample tree, every input hash and build runtime.
The checksum manifest lists every
bundle file except itself. The build uses Vite's `demo` mode and relative asset paths so the bundle
can live below a site subdirectory. Do not copy deployment settings or real identifiers into the
demo bundle.

The demo includes the Cross-vendor view (Portfolio, Adoption trends, Coding output,
Spend & credits, Native usage, Cost & evidence, Source coverage and Methodology), plus
comparison panels on Executive summary, Adoption, Consumption, Efficiency and Leaderboards.
Its seeded 91-day comparison keeps a separate four-organization, 278-person scenario, not the
170-person CSV sample or a Fabric export. Monthly active users cover their labelled month,
not the app's all-date totals. Vendor counts can overlap; native units, credits and USD spend
are not added together. The native-source evidence fixture is separately identified and is not
a population total. The Microsoft Copilot snapshot uses the same seeded monthly active people
and credits as the scenario charts, not a live export; GitHub usage remains deferred.
The view's own vendor/product filters work locally; app-wide filters do
not apply. `.env.demo` enables this view only for the static demo build; ordinary builds keep
it disabled unless `VITE_CROSS_VENDOR_DEMO=true` is explicitly set.

All app builds use the product title **DataHub App**, including desktop and mobile navigation
and report exports. The `VITE_DATAHUB_PREVIEW` flag remains accepted for compatibility; it does
not select a different product title. Existing demo links and deployment identifiers are unchanged.
Existing `Analytics Hub Viewers` groups and the `Analytics Hub - Agent inventory` fallback flow
keep their operational names; the product title change does not rename deployed resources.

### Separate DataHub App-only synthetic demo

The additional `demo-analytics.html` target excludes the comparison destination, its eight stages,
embedded comparison panels and scenario assets. It does not replace `demo.html`, `build:demo`,
`dist-demo`, or an already-published site.

```powershell
npm run build:demo:analytics
npm run preview:demo:analytics
```

Open the localhost URL printed by the preview command. This is a standalone offline demo, not
the Fabric portal development flow. No installer, pipeline, tenant access, refresh or deployment
is involved. Building does not publish anything.

In addition to the unchanged published sample pack, this target generates deterministic synthetic
Microsoft 365 activity, Agent Evaluator sessions/turns/topics/citations/feedback, Defender findings
and Resource Graph configuration. The generators under `scripts/demo_sources` use the existing
170-person synthetic inventory and original **1 June–31 August 2026** window. They do not read
tenant data, private configuration, Confidential sources or chart-test snapshots. Related metrics,
selectors, narratives, charts and grids are reduced from these generated records rather than
independently seeded visual values. Generated configuration uses the published agent registry.
Foundry inventory links to resource IDs in the published synthetic consumption sample.

The Azure-billed Copilot panel uses a **separate generated synthetic billing scenario**, not an
invoice or a reconciliation to the existing consumption exports. The existing consumption
snapshots retain their native cohorts, dates and totals. Budget runway starts with explicitly
labeled demo-only monthly assumptions of $1,000 for Cowork, $2,000 for Studio and $15,000 for Azure;
these can be edited in memory. The original demo still starts without monthly budgets. Ask remains
a clearly labeled local example, not a connected analytical service.
Existing small-cohort privacy suppression and "too early" projection guards remain in place;
populating the source records does not bypass those safeguards or invent a projection.

`npm run demo:data:analytics` regenerates the core sample payload plus the ignored generated
source payloads. `npm test` generates both packs before testing. The new bundle is isolated in
`dist-demo-analytics`, with a `COVERAGE.json` map of every retained stage and query source.
`SOURCE_PROVENANCE.json` records generator hashes, seeds, record counts and payload hashes separately
from published sample provenance. All records and findings are synthetic, not observations about
any real organization. Keep provenance, coverage, license notices and checksums with the bundle.
Public-site publication requires separate approval.

## Deploy it by hand

You need:

- A published ValueLens semantic model, from the [Fabric](../1-fabric/README.md) or [Azure](../2-azure/README.md) path.
- A workspace on Fabric capacity (F2 or larger, or a trial). *My workspace* won't work.
- The tenant settings **Fabric Apps (preview)** and **Semantic Model Execute Queries REST API** turned on.
- [Node.js](https://nodejs.org/) 24.15 or later, or 22.22 or later.

From this folder (`app`):

1. Run `npm install`.
2. In [`fabric.yaml`](fabric.yaml), replace `workspaceId` and `itemId` under `vl` with your
   ValueLens model's IDs. They're in the model's URL:
   `app.powerbi.com/groups/<workspaceId>/datasets/<itemId>`. Do the same under `cc` for
   Consumption Central and `ae` for Agent Evaluator, or delete those blocks to hide their pages.
3. Deploy, and sign in when asked:
   ```powershell
   npx rayfin up --workspace-uri "https://app.fabric.microsoft.com/groups/<workspace-id>"
   ```
   Add `--tenant <tenant-id>` if your account spans tenants.
4. Open the **Fabric portal** link it prints. To call the item **DataHub App**, rename it in its
   settings.
5. Share it. Each person needs:
   - the app: *Run and interact* on the item (share it with a group once), not a workspace role
   - the data: **Build** on each model the app reads

   The installer does this with one group, **Analytics Hub Viewers** (its existing operational name). By hand, add an `access`
   object to `fabric.config.json` so the app shows who to ask and links to the group:
   `{ "groupId": "<object id>", "groupName": "...", "contact": "you@example.com", "requestUrl": "https://..." }`
   (`requestUrl` is optional and must be https).
6. Optional: to link the **Ask** page to a Fabric data agent, add
   `"ask": { "workspaceId": "<workspace id>", "itemId": "<data agent id>" }` to `fabric.config.json`.
   The installer creates the agent and adds this for you; see [Ask](../installer/README.md#ask).
   Without it the page lists suggested questions and how to turn Ask on.

To update it, get the released app source and dependencies, keep the existing deployment and
model bindings, then run `npx rayfin up` again. Changes that require new model definitions,
including the expanded **Group by**, need the model update and successful refresh first; an
app-only redeploy is not enough. For installer-managed deployments, use
[Update](../docs/UPDATE.md#update-an-existing-installation-for-the-expanded-group-by) instead.

## Settings in the app

Anyone who can open the app can change these, and the change applies for everyone. Share the item
only with people who should.

- **Rates & packs** (Consumption page): your pay-as-you-go rate, prepaid rate and Capacity Pack
  balance. Leave a box empty to keep the model's value.
- **Monthly budgets** (Consumption page): an optional monthly budget for Cowork / Work IQ, Copilot
  Studio and Azure, for the Budget runway section. Leave a box empty for no budget.
- **Prices** (Value page, Cost vs value): the Copilot licence price ($30 if empty), the reporting
  currency for the Value page (US dollars unless the installer set another) and, for any other
  currency, the exchange rate per $1.
- **Time per task** (Assumptions page): the minutes each task would take without Copilot.
  **Use research** puts them back.

The app saves these in a small SQL database under its item. The Power BI report doesn't see them.

## Reports

A report pack is a named, ordered list of sections taken from any page. Packs are listed under
**Reports** in the sidebar.

- **Built-in packs.** *Exec pre-read*, *Finance weekly* and *Adoption review* come with the app.
  You can't edit or delete them, but **Save a copy** starts a new pack from one.
- **Your packs.** **New pack** opens an editor where you name the pack, tick sections from each
  page, and put them in order. On Fabric anyone who can open the app can save, edit or delete a
  pack, and it changes for everyone. On Azure that needs the `AnalyticsHub.Admin` role. Packs are
  stored with the other settings: in the app's SQL database on Fabric, and in Table Storage on
  Azure.
- **Missing sections.** A pack skips a section whose page is hidden because its optional data
  hasn't arrived, and says which ones it left out.
- **Download PDF** and **Download PowerPoint** are on every page and every pack. Both show the
  filters in use and the date the data runs to, and the file is named after it, such as
  `exec-pre-read-data-to-2026-10-11.pdf`. The PDF uses the browser's print dialog: choose
  **Save as PDF**. Where the browser can't open a print dialog, the report downloads as an HTML
  file you can print later. The PowerPoint deck opens with a cover listing the filters, the data dates and any
  sections left out, then has one slide per chart or table.
- **Download CSV** on each chart and table also adds the data date to the file name.

## Change the app

| Task | How |
|---|---|
| Preview live | `npm run dev`, then open the app in Fabric with `&devUri=http://localhost:5173` on the URL |
| Test | `npm test` and `npm run lint` |
| Edit a query | `src/queries/<page>/`: a `.dax` query and a `.ts` definition per visual |
| Edit a page | `src/screens/<page>/` |

Don't commit your IDs in `fabric.yaml` or the redirect URI that `rayfin up` adds to
`rayfin/rayfin.yml`. Its local state files are gitignored.

The installer ships one build for every tenant, so it reads the model IDs from a
`fabric.config.json` deployed next to the app. Newer files also include a `modules` block for the
optional module choices. A deploy from this folder uses `fabric.yaml` instead. See
[`src/lib/runtime-config.ts`](src/lib/runtime-config.ts).
[`AGENTS.md`](AGENTS.md) has the conventions for coding agents.

## How it works

### Group by

**Group by** offers the meaningful attributes in your org data, including custom columns,
business codes, hierarchy levels, numbers, booleans and dates. It does not impose a maximum
number of distinct groups. Person identifiers, individual names, full hierarchy paths and
internal processing fields stay out, as do attributes with fewer than two populated values.
A blank plus one real value is still a single-value attribute.

The main app and Agent Evaluator discover their own model's attributes rather than sharing a
fixed field list. The Evaluator keeps Agent and Topic choices and offers an org grouping only
when at least two populated groups have conversations. Its grouping eligibility loads when
you open **Group by**, not with the landing page. Cowork and Studio read their model's org
attributes, including sparsely populated ones, while retaining their product-specific usage
intensity choices and per-person exclusions.

Attribute discovery does not fetch every attribute's value list. The main app reads the
model's `Org Attribute Source` membership table, checking at most two populated distinct
values per attribute in one query; only the selected attribute's values load when a filter
menu opens. Numbers, booleans and dates are serialized by the model into invariant text for
grouping and filtering, without changing source column types.

The updated model templates build that membership table from all source org columns on
each refresh. New columns therefore become available after the data loads and the model
refreshes, without manually adding a model column for each attribute. An existing installation
needs the updated model definition as well as the app; an app-only update cannot expose
attributes an older model has not loaded.

<details>
<summary><strong>Pages that need optional data</strong></summary>

The app leaves out pages and sections whose optional data hasn't arrived. When it opens, it
counts the rows in the ValueLens model's optional sources (unfiltered), in one query. **Feedback**
needs `ProductFeedback` and **Work patterns** needs `M365 Activity`. Without registry data, **Governance**
reads the Copilot Studio agents Azure Resource Graph loads, says above each tab what that leaves out,
and only asks for a source when neither has data. The **Agents** leaderboard
drops its registry columns. Governance's **Shadow AI** section needs `Defender Status`, and says how to
turn Defender on without it; it doesn't depend on the registry. Newer installer builds also write which optional modules were switched
off into `fabric.config.json` (on Azure, the web app serves them in `/app.config.json`); those
pages stay hidden without probing until the admin turns the module on. Everything shows while the
check runs, or if it fails, and a page comes back on the next open once its data loads.

</details>

<details>
<summary><strong>How pages load</strong> (built for about 20,000 people)</summary>

<a id="how-pages-load"></a>

The app is built to stay quick for a large tenant (about 20,000 people):

- **The last 12 weeks by default on a large tenant.** When more than 10,000 people have Copilot
  activity, the date filter starts at **Last 12 weeks**: the 84 days to the last day with activity.
  The filter bar shows the dates and says it's the default for large organizations; **Show all
  dates** widens it in one click. Each query works out the tenant's size and the 12 weeks itself,
  so the first page doesn't wait for the filter options. A smaller tenant starts on **All dates**.
  **Reset filters** goes back to the tenant's default. Consumption Central and the Agent Evaluator
  keep every date until you choose a range, and say so on a large tenant. `LARGE_TENANT_PEOPLE` in
  `src/lib/filters.ts` sets the threshold.
- **One tab at a time.** Each page shows one section at a time, as tabs, and opening a tab runs
  only that tab's queries. Downloads and report packs still include every section.
- **The first page asks only what it shows.** The Executive summary opens with eight queries, or
  nine with org-scoped access. Load status and org attribute discovery, including its bounded
  eligibility check, load in the background. When a
  filter menu other than the dates first opens, the menus' choices load, so that first open can
  take about a second, or a few if the org columns haven't loaded yet. The org columns then move on
  screen, as they do when a breakdown by org shows. See [How the app opens](../docs/ARCHITECTURE.md#how-the-app-opens).
- **Long lists wait for a click.** The leaderboard ranking and the by-organization and by-person
  lists load when you choose **Show …**. The cards above them still count everyone, and downloads
  and report packs still print the lists in full.
- **The next pages load in the background.** Once the page on screen has loaded, the app fetches
  the first tab of the next two pages in the menu, one query at a time, and waits whenever the page
  on screen is loading. Opening another page fetches the two after that one. If you open a page
  while its query is waiting, the query starts at once. `PREFETCH` in
  `src/components/prefetcher.tsx` turns this off, and `PREFETCH_AHEAD` in
  `src/components/prefetch-targets.ts` sets how many tabs are fetched.
- **A busy model slows down on its own.** If Power BI throttles a model, even inside a normal
  reply, only that model's queries wait: 1, 2, 4, 8, then 15 seconds, one query at a time, for
  up to a minute. A `Retry-After` is kept in full: if it's longer than the wait left, the card
  gives up at once rather than ask the model early. Then the card shows **Power BI is busy**, and
  **Try again** asks the model, not the cache. Once the model answers any query again, every card
  that showed busy, and the filter choices, ask again by themselves, with no click, however many
  cards share the query; a page you open after a throttle sends its queries rather than giving up
  at once. Background loading from that model stops for at least a minute, and until a query to
  it on screen succeeds. Other query errors aren't retried or shown as busy, even one about a
  table called `Rate Limit` or `Power BI is busy`. A card you leave stops waiting; a query already
  sent still finishes. A card that switches query or model shows only its current query's result
  and busy state, never its old one's. The browser console logs each step (`DataHub App: …`).
- **Results last for the visit.** The app holds up to 1,000 results in memory, each for up to an
  hour, so a page you've seen opens again without asking the model. Nothing is kept between opens.
  A preview build stored results in IndexedDB (`analytics-hub-results`); the app deletes that
  database as it starts.
- **Cowork and Copilot Studio credits by group** don't offer per-person groupings (User, User Key,
  id, employee Id, Hierarchy Path, Level5_User Key), which took one to two and a half minutes each
  at 20,000 people. A saved grouping that is no longer offered shows **All users**.

</details>

<details>
<summary><strong>Bounded detail lists</strong> (top 1,000 rows)</summary>

<a id="bounded-detail-lists"></a>

Person and registry detail lists return the top 1,000 rows, with deterministic
tie-breakers. Consumption's Studio agent list follows the same limit. Sorting
or filtering inside a grid acts on those returned rows; use the page filters
to query another selection. Truncation notices identify omitted rows and flag
unavailable full counts rather than substituting the displayed row count.

Group and grand totals still cover the full filtered population, including
groups whose people are outside the cap. Person-row counts can include the
same person under multiple groups. Leaderboard and Studio concentration are
computed separately across all person rows, combining repeat person keys
before selecting positive values; Leaderboard returns only the top 1%, 5%
and 25% cuts, without a curve. Value by habit returns whole-population
habit totals and concentration cuts, not a truncated person list. Agent
spotlights return full-population maxima and tie counts with two named
winners; separate agents with the same display name still count separately.

These payload limits are not proof of lower model latency. Query-shape and
synthetic tests do not establish live DAX equivalence. Validate against the
same model, data, filters and assumptions before deployment; the request
scheduler's concurrency, pacing and retry protections must stay unchanged.

</details>
