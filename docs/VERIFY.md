# Verify

How to tell the install worked, and what's left to do.

1. **Read the Done page.** It lists what's left, as cards: who does each step and a message to
   send. See [After it finishes](#after-it-finishes).
2. **Check what loaded.** After the first run, each source has a card: loaded, warning, failed,
   skipped or still running. A failed card says why and what to do. On Fabric, the same is in the
   Lakehouse table `dbo.load_log`. See [Load status and reruns](../installer/README.md#load-status-and-reruns).
3. **Check status.** Open the installer again and choose **Check status** (`status`): recent runs,
   model refreshes, secret expiry and the last data check. On Azure it also shows the job runs,
   the web app's URL and pending admin actions. It changes nothing.
4. **Check the data** (Fabric). **Check the data** (`check`) reads the Lakehouse tables for row
   counts, date ranges and licence matches, without running the pipeline.
5. **Open the app.** Open the link the installer gives you. Each page lists the latest date each
   of its sources holds. Pages for sources you skipped stay empty.

Something failed? Choose **Rerun failed loads** (`rerun-failed`), or see
[Troubleshooting](TROUBLESHOOTING.md).

## After it finishes

- **What's left comes first.** The Done page (and the end of the terminal output) starts with
  "N steps left": a card for each thing still to do, in order, with who does it, why, a link and
  the steps. For a step another admin does, the card has a message to copy and send:
  - **Share the app**, if you chose **Later** when asked.
  - **Sign in to the Power Automate flows**, for you or a Power Platform administrator.
  - **Sign in to the Cowork Dataflow.** Until then its refresh fails on each run. That's expected,
    so the load shows it as waiting rather than failed.
  - **Ask a Viva Insights analyst for the Cowork credits query** (optional), when Cowork credits
    come from the CSV export.
  - **Ask a Privileged Role Administrator for Global Reader** for **Analytics Hub Data
    Collector**, when agent configuration comes from Azure Resource Graph. The message has the
    app's IDs, the link to Roles & admins, and a Cloud Shell command.
  - **Ask a Microsoft 365 admin to schedule the product feedback export**, when its flow is on.
- **Admin consent.** If you couldn't grant it, send the link the installer gives you to an admin.
  They select **Grant admin consent**. Then open the exe again and choose **Run now**.
- **Share the app and reports.** The installer creates **Analytics Hub Viewers** (or uses a group
  you name) with you as owner, and gives it **Build** on the models. Then:
  1. **Once:** share the app with the group. Straight after the app is deployed, before the first
     load, the installer asks you to, with a link to the app item in Fabric: choose **Share**, add
     the group and choose **Grant**. (Or in the workspace, choose **…** next to the
     **Analytics Hub** app, then **Share**.) Choose **I've shared it** and it isn't asked again.
     Choose **Later** and it's a card on the Done page, and Repair asks again. Do the same for the
     **ValueLens** report.
  2. **To give someone access:** add them to the group in
     [My Groups](https://myaccount.microsoft.com/groups). You can also run `access`
     (**Manage access** in the browser) or use **Share** in the app.

  Keep viewers off workspace roles. See [Viewing Analytics Hub](PERMISSIONS.md#viewing-analytics-hub-paths-1-and-2).
- **Own reports.** Connect Power BI Desktop to `Analytics Hub Model`, or use **Save a copy** on a
  published report.
- **Flows and the Cowork Dataflow.** If you chose them, the end of the install lists what to sign
  in to. See [Power Automate flows](../installer/README.md#power-automate-flows) and
  [Credit consumption](../installer/README.md#credit-consumption).
- **Someone else takes over the pipeline?** The notebooks run as the person who last changed the
  pipeline, or the schedule's owner. Give them Key Vault Secrets User on the vault and Contributor
  on the workspace first. With the secret in the notebooks, they only need Contributor.
- **Secrets expire.** See [Secrets expire](UPDATE.md#secrets-expire).
