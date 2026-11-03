# DataHub app

The ValueLens dashboard as a web app in your Fabric workspace. The [installer](../installer/README.md)
deploys it for you. Use this folder only to deploy it by hand or to change it.

The app keeps no copy of your data. Each page queries the semantic model live, as the person
viewing it, so row-level security applies. How each figure is worked out is in the
[methodology](../docs/METHODOLOGY.md).

## Static browser demo

The standalone DataHub browser demo at `demo.html` uses the real app screens with generated synthetic
sample data. It does not read host configuration, ask you to sign in, or contact a model or app
backend. Ask returns a local example answer; settings changes stay in memory for the current page
session, and admin-only actions are disabled.

From this folder, install the app dependencies and run:

```powershell
npm run build:demo
```

The self-contained static bundle is written to `dist-demo`. Serve that directory from any static
file host; `index.html`, its local assets, the MIT `LICENSE.txt`, and the generated
`THIRD_PARTY_NOTICES.txt` and `SHA256SUMS.txt` travel together. The checksum manifest lists every
bundle file except itself. The build uses Vite's `demo` mode and relative asset paths so the bundle
can live below a site subdirectory. Do not copy deployment settings or real identifiers into the
demo bundle.

The demo includes the Cross-vendor view (Portfolio, Adoption trends, Coding output,
Spend & credits, Native usage, Cost & evidence, Source coverage and Methodology), plus
comparison panels on Executive summary, Adoption, Consumption, Efficiency and Leaderboards.
Its seeded 91-day comparison uses the same four organizations, 278 licensed-seat cohort and
198 Copilot users as the other demo fixtures. Monthly active users cover their labelled month,
not the app's all-date totals. Vendor counts can overlap; native units, credits and USD spend
are not added together. The native-source evidence fixture is separately identified and is not
a population total. The Microsoft Copilot snapshot uses the same seeded monthly active people
and credits as the scenario charts, not a live export; GitHub usage remains deferred.
The view's own vendor/product filters work locally; app-wide filters do
not apply. `.env.demo` enables this view only for the static demo build; ordinary builds keep
it disabled unless `VITE_CROSS_VENDOR_DEMO=true` is explicitly set.

The demo build also sets `VITE_DATAHUB_PREVIEW=true` to use DataHub in desktop and mobile
navigation, cross-vendor copy and report exports. Its HTML title, description and bundled
README use DataHub too. Ordinary builds retain their existing branding unless explicitly
opted in; deployment identifiers and access-group names are unchanged.

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
4. Open the **Fabric portal** link it prints. To call the item **Analytics Hub**, rename it in its
   settings.
5. Share it. Each person needs:
   - the app: *Run and interact* on the item (share it with a group once), not a workspace role
   - the data: **Build** on each model the app reads

   The installer does this with one group, **Analytics Hub Viewers**. By hand, add an `access`
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
  and busy state, never its old one's. The browser console logs each step (`Analytics Hub: …`).
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
