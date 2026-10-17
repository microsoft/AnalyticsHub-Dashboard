# teams: Analytics Hub tab package

This folder contains the Teams manifest template and package builder for Analytics Hub on Azure. The package contains:

- `manifest.json` using Teams manifest schema v1.17.
- `color.png` (192x192) and `outline.png` (32x32, white on transparent).
- A personal static tab at `https://<fqdn>/?host=teams`.
- A configurable team/group chat tab at `https://<fqdn>/?host=teams&config=1`.
- `webApplicationInfo` for single sign-on with resource `api://<fqdn>/<clientId>` unless overridden.

Build a package with no dependencies:

```powershell
node build-package.mjs --client-id <guid> --fqdn <host> --version 0.1.0 --out AnalyticsHub-Teams.zip
```

The module also exports `buildTeamsPackage({ clientId, fqdn, appIdUri, version })`, returning a zip `Buffer` so the installer can generate the package in-memory.

## Give it to everyone

The installer publishes `AnalyticsHub-Teams.zip` to your org's app catalog straight after it writes it, so nobody has to upload it. Within a few hours, people find **Analytics Hub** in Teams under **Apps** > **Built for your org**.

Once it's in Teams, people can also add **Analytics Hub** from **Apps** in Outlook and the Microsoft 365 Copilot app ([Microsoft Learn](https://learn.microsoft.com/microsoftteams/platform/m365-apps/publish)): the same personal tab, with the same sign-in. The channel and group chat tab stays in Teams.

The tab signs people in as it opens (single sign-on), in each of them. If the host first needs a prompt, such as consent or MFA, the tab shows **Sign in with Microsoft**. Who can open it is the same as the web app: members of the viewer group, or anyone with the `AnalyticsHub.User` app role.

### What publishing needs

- **A Teams admin.** Whoever runs the installer needs the **Teams Administrator** or **Global Administrator** role, active. With Privileged Identity Management, activate it before you sign in.
- **One more sign-in**, at the start of the install, to **Microsoft Graph Command Line Tools**. The plan asks first, and you can say no. It asks for *Read and write to all app catalogs* (`AppCatalog.ReadWrite.All`, delegated), which needs admin consent. A Global Administrator, Privileged Role Administrator, Cloud Application Administrator or Application Administrator can give it at the prompt. Anyone else sees **Need admin approval**: use that page's link back to the app, and the installer carries on with the steps below. If the sign-in isn't finished within 5 minutes, for example because the browser was closed, the installer carries on without it. [Permissions](../../docs/PERMISSIONS.md#publishing-the-teams-app-path-2) says who the consent covers and how to revoke it.
- **Not `--use-az`.** The Azure CLI's sign-in can't ask for this permission, so with `--use-az` you get the steps below.

**Later runs.** **Repair or change**, **Update** and upgrades update the same app when the package has changed, and don't sign in for it when it hasn't. They never add a second one. An app uploaded by hand has the same ID (the web app's client ID), so the installer finds it, updates that one and looks after it from then on. If the catalog has a newer version, the installer leaves it alone. If Teams turns down an update at the same version, the steps below stay pending and the next run tries again.

### If the installer can't publish it

A missing role or consent, a policy, an error, a sign-in that isn't finished within 5 minutes, or a no when the plan asks: none of them stops the install. The package stays next to the install record, and the installer prints the steps. **Check status** (`status`) lists them as a pending admin action until a later run finds the app published. A Teams Administrator:

1. Opens [Teams admin center](https://admin.teams.microsoft.com/policies/manage-apps) > **Teams apps** > **Manage apps**.
2. The first time, selects **Upload new app** > **Upload** and chooses `AnalyticsHub-Teams.zip`. To update it, selects **Analytics Hub**, then **Upload file** on its page.
3. If it's waiting for approval, selects it, then **Publish**.

Once someone with the role and consent above can run the installer, choose **Repair or change**, and the installer looks after the app from then on.

### Pin it, and who can add it

- **Pin it (optional).** In the Teams admin center, under **Teams apps** > **Setup policies**, add **Analytics Hub** to a policy's pinned apps and assign that policy to the **Analytics Hub Viewers** group ([app setup policies](https://learn.microsoft.com/microsoftteams/teams-app-setup-policies)). There's no Graph API for setup policies, so the installer doesn't do it.
- **Who can add it.** Publishing doesn't change who can use custom apps. If people can't find it, check that **Org-wide app settings** allow custom apps ([manage apps](https://learn.microsoft.com/microsoftteams/manage-apps#manage-org-wide-app-settings)), that their [app permission policy](https://learn.microsoft.com/microsoftteams/teams-app-permission-policies) allows it, and that it isn't blocked in **Manage apps**. The installer doesn't check or change these.
- **To try it first**, upload it as a custom app (**Apps** > **Manage your apps** > **Upload an app**).
