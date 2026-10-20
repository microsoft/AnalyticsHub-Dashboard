# Sample data

Synthetic data for trying Analytics Hub with no tenant data. **None of it is real.** People,
organisations, agents, prompts and usage are all invented. Addresses use `contoso-demo.com` and
`contoso-health.com`, and every ID is a placeholder.

| Folder | What it is | Used by |
|---|---|---|
| `samples/` | Copilot interactions, licensed users and org data for a 170-person company over three months, plus an Agent 365 registry and a product feedback export | Azure demo mode (`VALUELENS_SAMPLE_DATA=true`) |
| `samples/consumption/` | Consumption Central exports for Copilot Studio, Copilot credits, GitHub and Azure AI Foundry over the same thirteen weeks | The Fabric seeder [`seed_sample_data.py`](../fabric/Add%20Credit%20Consumption/seed_sample_data.py). Not Azure demo mode yet: it leaves [credit consumption](../azure/README.md#credit-consumption) out for now |

The `valuelens-jobs` image bundles these files at `/app/sample-data`, so an Azure install can show a
full dashboard before any tenant data is collected. On Fabric, `product_feedback_sample.csv` also
works as a real export: drop it in `Files/product_feedback/` and run
`Copilot_ProductFeedback_Ingester`. Azure demo mode doesn't load it, but out of demo mode, with
product feedback on, it works as a real export there too: drop it in `product_feedback/` (see
[Product feedback](../azure/README.md#product-feedback)).

## Where the files come from

The files are generated, not redacted. The generator and its notes stay with the Power BI templates
in [ValueLens](https://github.com/microsoft/ValueLens-for-Microsoft-Copilot) (`5. Local CSV/sample-data`),
because it imports the Local CSV processor to derive every classified column. To refresh the samples,
regenerate them there and copy the CSVs here unchanged.
