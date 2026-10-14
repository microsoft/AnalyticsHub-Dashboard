# Manual setup

Moved to **[Manual install](../docs/MANUAL-INSTALL.md)**: prerequisites, install and verify, step
by step. The [installer](../installer/) does all of this for you, using these same files.

<a id="steps"></a><a id="optional-extras"></a>

## What's here

| Item | What it is |
|---|---|
| `ValueLens - Fabric.pbit` | The report, reading the Lakehouse SQL analytics endpoint. |
| `ValueLens - Fabric OneLake.pbit` | The same report, reading OneLake directly. |
| [`notebooks/`](notebooks/) | The core notebooks. The extras' notebooks are in `credit-consumption/` and `agent-evaluator/`; `workday-org-data/` adds HR columns. |
| [`pipelines/`](pipelines/) | The pipeline that runs the notebooks. |
| [`Add Credit Consumption/`](Add%20Credit%20Consumption/) | The Consumption Central report: credits and cost across Copilot Studio, Copilot Cowork and Azure AI. |
| [`Add Agent Evaluator/`](Add%20Agent%20Evaluator/) | The Agent Evaluator report: how well your Copilot Studio agents work. |
| [`flows/`](flows/) | A Power Automate flow that saves the emailed product feedback export to your Lakehouse. |
