# Analytics Hub app

## Platform

A Fabric app (or, on the Azure path, a web app) that the [installer](../installer/README.md)
deploys next to the semantic models it reads. It's designed for desktop first (1280–1600px) and
still works at 390px wide.

## Users

- **Adoption and change leads.** They track Copilot, Copilot Chat and agent use, and see how habits
  form.
- **Value and ROI owners.** They estimate the hours and value Copilot saves, using their own
  assumptions, and report it to leadership.
- **IT, licence and budget owners.** They decide who gets a licence next, and track what Cowork,
  Copilot Studio and Azure AI Foundry credits cost against budget.
- **Agent owners.** They see how well their Copilot Studio agents answer, and where they fall short.

## Purpose

One app over three models: ValueLens, Consumption Central and Agent Evaluator. It looks and
navigates like the ValueLens and Consumption Central App Editions: a product switcher, tabs and
short sub-views instead of many report pages. Settings that were parameter tables (task times,
prices, rates and budgets) are edited in the app.

## Data

- Every page queries its semantic model live, as the person viewing it, so row-level security
  applies. The app keeps no copy of the data; results are cached in memory for the visit.
- Each view asks for the grain it needs, using the models' own DAX measures. It never pulls raw
  rows: the Execute Queries API caps a query at 100,000 rows.
- Optional pages and products show only when their data or model is there.

## Constraints

- Figures must match the models' measures. How each one is worked out is in the
  [methodology](../docs/METHODOLOGY.md).
- On Fabric, access is through one viewer group, which also gets **Build** on the models. On Azure,
  it's through the app's roles.
- No external CDNs, fonts or network calls beyond the Fabric or Azure APIs.
- Accessibility: WCAG AA contrast, all controls reachable by keyboard, and visible focus.

## Brand and tone

Microsoft-adjacent, calm and analytical. A dark-teal header band over a white working surface.
Labels in plain English, and the numbers are the hero. Value estimates are shown as estimates,
with their caveats beside them.

## Anti-goals

- No marketing hero, decorative gradients or illustrations.
- No cards nested inside cards.
- Never drop a figure to simplify. Simplify by grouping and navigation instead.
- Never present estimated value as measured savings.
