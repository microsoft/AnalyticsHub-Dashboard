# Manual install

Set Analytics Hub up by hand, step by step, without the installer. It uses the same files the
installer does. Use it only if no [install route](INSTALL.md) works for you, or you want to see
each piece.

- **Fabric only.** Azure can't be set up by hand. See [Azure](#azure).
- **It takes longer**, and you update it by hand. The [installer](INSTALL.md) is quicker and
  does more for you: see [What you don't get by hand](#what-you-dont-get-by-hand).
- **Watch first:** the [manual setup video](../fabric/README.md#set-it-up-by-hand), from a fresh
  app registration to a self-refreshing report.

## 1. Prerequisites

Everything in [Prerequisites](PREREQUISITES.md) for Fabric, plus:

| You need | Why |
|---|---|
| An Entra **app registration** you create, with the Graph permissions in [Permissions](PERMISSIONS.md#core-sources-required), admin consent and a client secret | The notebooks sign in as it. The installer creates it for you |
| Somewhere for the secret: an Azure **Key Vault** (with *Key Vault Secrets User* for whoever runs the notebooks), or the notebooks themselves | Key Vault keeps it from workspace viewers. See [Where the client secret goes](../fabric/README.md#where-the-client-secret-goes) |
| A Fabric workspace with a **Lakehouse**, with **Lakehouse schemas** on | Where the data lands |
| **Power BI Desktop** | To open the report template and publish it |
| [Node.js](https://nodejs.org/) 24.15 or later, or 22.22 or later | Only to deploy the app |

The Fabric admin's tenant settings are in
[Prerequisites](PREREQUISITES.md#fabric-admin-about-5-minutes).

## 2. Install

Do these in order. Each link has the steps.

1. **[Load the data](../fabric/notebooks/README.md).** Import the 4 core notebooks, attach the
   Lakehouse, fill in the first cell, run the ingesters, then the processor.
2. **[Publish the report](../fabric/notebooks/README.md#load-the-data)** (step 6). Open
   `ValueLens - Fabric.pbit` in Power BI Desktop and publish it. This also gives you the
   semantic model the app reads.
3. **[Schedule it](../fabric/pipelines/README.md).** Paste the pipeline, fill in the IDs, run it
   once and schedule it. Then
   [refresh the model from the pipeline](../fabric/pipelines/README.md#refresh-power-bi-from-the-pipeline).
4. **[Deploy the app](../app/README.md#deploy-it-by-hand)** *(optional).* Point `fabric.yaml` at
   your model and run `npx rayfin up`. Then share it.
5. **Add extras** *(optional).* Each has its own steps:

   | Extra | Steps |
   |---|---|
   | Agent 365, Microsoft 365 activity, product feedback, Defender, Azure Resource Graph | [Optional notebooks](../fabric/notebooks/README.md#optional-notebooks), then turn each on in the [pipeline](../fabric/pipelines/README.md#optional-sources) |
   | Credit consumption | [Add Credit Consumption](../fabric/Add%20Credit%20Consumption/README.md) |
   | Agent Evaluator | [Add Agent Evaluator](../fabric/Add%20Agent%20Evaluator/README.md) |
   | Product feedback flow | [flows](../fabric/flows/README.md) |
   | Workday org data | [Workday org data](../fabric/notebooks/workday-org-data/README.md) |

## 3. Verify

1. **The pipeline ran.** In Fabric, open **Monitor** > **Pipeline runs**. Check each activity, not
   just the run: see [If a run fails](../fabric/pipelines/README.md#if-a-run-fails).
2. **The data is there.** Run the `ValueLens_Data_Check` notebook. It shows row counts and date
   ranges, and changes nothing.
3. **The report refreshed.** Open it in Power BI. People show as IDs? See
   [People show as IDs](../fabric/notebooks/README.md#people-show-as-ids).
4. **The app opens** *(if you deployed it).* Each page lists the latest date its sources hold.

Something wrong? See [Troubleshooting](TROUBLESHOOTING.md), including its [known issues](TROUBLESHOOTING.md#known-issues).

## Update

There's no **Repair or change** by hand. For a new version:

- **Notebooks:** import the new ones over the old, and fill in the first cell again.
- **Pipeline:** paste the new JSON, fill in the IDs again, and re-add your refresh step. See
  [the pipeline](../fabric/pipelines/README.md#if-a-run-fails).
- **App:** run `npx rayfin up` again from `app`.
- **Secret:** replace it in Key Vault or the notebooks before it expires.

## What you don't get by hand

The installer does these. By hand, you do them yourself or go without:

- The **Analytics Hub Viewers** group and sharing.
- The **Ask** page's Fabric data agent.
- The Power Automate flows and the Cowork Dataflow, set up and named for you.
- The upload router and its folders, and **Upload CSV** for exports.
- Load status cards, **Check status**, **Check the data**, **Rerun failed loads**, secret
  rotation and update checks. These need an [install record](INSTALL.md#run-it).
- The settings for [a large tenant](../fabric/notebooks/README.md#a-large-tenant), set for you.

Want them? Use the [installer](INSTALL.md) instead, in a new workspace.

## Azure

**Not supported by hand.** An Azure install needs steps that a template can't do: Graph app roles
for the managed identity, the database users, the web app's registration and the Power BI models.
Only the installer does them. See
[After deployment](../azure/README.md#after-deployment-installer-steps-not-arm).

If your PC can't run the installer, run it in
[Azure Cloud Shell](INSTALL.md#locked-down-tenant--azure-cloud-shell). Nothing runs on your PC.
