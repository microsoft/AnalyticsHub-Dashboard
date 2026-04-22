> ⚠️ **Support Notice**
> This repository is not supported through Microsoft support channels. Please report issues by opening an issue in this repo.

# 💼 AI Business Value Dashboard

<p style="font-size:small; font-weight:normal;">
This repository contains the <strong>AI Business Value Dashboard</strong> Power BI template. It quantifies the business value of Microsoft Copilot and agent activity — translating raw audit signals into hours saved, assisted value, and a defensible ROI narrative aligned to Microsoft's Frontier Firm framework.
</p>

---

## 📸 Dashboard Preview

*(Add your screenshot or animated preview here — e.g. `Images/ABV-Preview.gif`)*

---

<details>
<summary>⚠️ <strong>Important usage & compliance disclaimer</strong></summary>

Please note:

While this tool helps customers better understand the business value of their AI usage data, Microsoft has **no visibility** into the data that customers input into this template/tool, nor does Microsoft have any control over how customers will use this template/tool in their environment.

Customers are solely responsible for ensuring that their use of the template tool complies with all applicable laws and regulations, including those related to data privacy and security.

**Microsoft disclaims any and all liability** arising from or related to customers' use of the template tool.

**Experimental Template Notice:**
This is an experimental template with audit logs as the primary source. The audit logs from Microsoft Purview are intended to support security and compliance use cases. While they provide visibility into Copilot and agent interactions, they are not intended to serve as the sole source of truth for licensing or full-fidelity reporting on Copilot activity.

</details>

---

## 📊 What This Dashboard Provides

- **Quantified business value** of Copilot and agent activity — hours saved and dollar-equivalent assisted value, grounded in research-sourced time baselines
- **Frontier Firm maturity view** — where your organisation sits on the Pattern 1 (human + Copilot) → Pattern 2 (human + agent) → Pattern 3 (agents run workflows) journey
- **Functional value breakdown** — value per function (Sales, HR, IT, Legal, Finance, Marketing, Customer Service) with defensible task-level attribution
- **Work archetype analysis** — Copilot activity mapped to Creating, Finding, Consuming, Producing, Automating
- **User maturity tracker** — Beginner → Developing → Proficient progression using behavioural breadth, agent adoption, and active days
- **Business case output** — projected annualised value, ROI multiple, and licence investment net

---

## 🚀 How This Helps Leaders

- **Build a defensible business case** for continued Copilot investment — tie value directly to the KPIs your CFO, CHRO, and CIO already care about
- **Identify Frontier Firm maturity by function** — see which functions are stuck in Pattern 1 and where Pattern 3 autonomy is emerging
- **Prioritise enablement investment** — see which work archetypes and functions have the highest value potential
- **Track progression over time** — compare functional value and maturity quarter-on-quarter as adoption matures

---

## ✅ What You'll Do

**Quick Overview**: Export 3–4 data sources → Connect them to Power BI → Analyse your AI value

### Choose Your Method

<details>
<summary>🖱️ Option A: Manual Export via Web Portal (Recommended for first-time setup)</summary>

Follow the traditional workflow using browser-based portals to export your data:

1. **Export Copilot audit logs** from Microsoft Purview
2. **Download licensed user data** from Microsoft 365 Admin Center
3. **Export org data** from Microsoft Entra Admin Center
4. *(Optional)* **Export Agent 365** data from Microsoft Admin Center
5. **Connect CSV files** to Power BI template

**Best for**: One-time setup, first-time users, or those who prefer GUI-based workflows

👉 **See detailed instructions below** in the [Detailed Steps](#-detailed-steps) section

</details>

<details>
<summary>⚡ Option B: Automated PowerShell Scripts (For regular refreshes)</summary>

The [AI-in-One Dashboard](https://github.com/microsoft/AI-in-One-Dashboard/tree/main/scripts) ships PowerShell scripts for the core audit-log export. The same scripts produce CSVs that work with this template — simply re-use them and point the template parameters at the outputs.

**Quick Start (Local execution)**:
```powershell
# 1. Install required modules
Install-Module Microsoft.Graph.Beta.Security -Scope CurrentUser

# 2. Run the AI-in-One export scripts
cd scripts
.\create-query.ps1              # Creates audit log query
.\get-copilot-interactions.ps1  # Exports query results
.\get-copilot-users.ps1         # Exports licensed users list
```

</details>

---

## 📁 Detailed Steps

<details>
<summary>🔍 Step 1: Download Copilot Interactions Audit Logs (Microsoft Purview)</summary>

### What This Data Provides
This log provides detailed records of Copilot interactions across all surfaces (Chat, M365 apps, Agents). The template classifies each signal into an AI task, maps it to a research-sourced human-time baseline, and computes the hours saved and assisted value.

### Requirements
- Access level required: **Audit Reader** or **Compliance Administrator**
- Portal: Microsoft Purview Compliance Portal
- Permissions needed: View and export audit logs

### Step-by-Step Instructions

1. **Navigate to the portal**
   - Go to: [security.microsoft.com](https://security.microsoft.com)
   - In the left pane, click **Audit**

2. **Configure the audit search**
   - In **Activities > Friendly Names**, select:
     - `Copilot Activities – Interacted with Copilot` *(required)*
   - Set a **Date Range** (recommended: 3 months for meaningful trend)
   - Give your search a name (e.g., `Copilot Audit - Apr 2026`)

3. **Run and export the search**
   - Click **Search**
   - Wait until the status changes to **Completed**
   - Click into the completed search
   - Select **Export > Download all results**
   - Save the CSV file to a known location (e.g., `C:\Data\Copilot_Audit_Logs.csv`)

📖 **Learn more**: [Export, configure, and view audit log records – Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/compliance/audit-log-search)

</details>

<details>
<summary>👤 Step 2: Download Copilot Licensed User List (Microsoft 365 Admin Center)</summary>

### What This Data Provides
A list of users with Copilot licences. Used by the template to compute licence investment, licensed-user coverage, and cost baseline.

### Requirements
- Access level: **Global Administrator** or **Reports Reader**
- Portal: Microsoft 365 Admin Center

### Step-by-Step Instructions

1. Go to [admin.microsoft.com](https://admin.microsoft.com) → **Users > Active users**
2. Filter by licence: **Microsoft 365 Copilot**
3. **Export > Export users**
4. Save as `Copilot_Licensed_Users.csv`

</details>

<details>
<summary>🏢 Step 3: Download Org Data (Microsoft Entra Admin Center)</summary>

### What This Data Provides
Organisation, department, job title, and country per user. Used to attribute value by function (Sales, HR, IT, Legal, Finance, etc.) via the auto-classifier and customer-editable override map.

### Requirements
- Access level: **User Administrator** or **Global Reader**
- Portal: Microsoft Entra Admin Center

### Step-by-Step Instructions

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **Users > All users**
2. Select **Download users**
3. Save as `Org_Data.csv`

### Function Classification
The template includes two layers:
- **Auto-classifier** (built in): pattern-matches on Organization + JobTitle to tag users as Sales / IT / HR / Legal / Finance / Marketing / Customer Service / Operations / Health & Safety
- **Org Function Map** (customer-editable): override the auto-classifier for org labels specific to your tenant. Edit via **Transform data > Org Function Map** in Power Query.

</details>

<details>
<summary>🤖 Step 4 (Optional): Agent 365 Export</summary>

If your tenant has Agent 365, export the agent list and supply it to the `Agent 365` parameter in the template. This enables agent-level attribution on the Agent Value page (agent leaderboards, shared agent reach, creator insights).

If you don't have Agent 365 data, leave this parameter blank — the rest of the dashboard works without it.

</details>

<details>
<summary>🧩 Step 5: Connect CSVs to the Template</summary>

1. Open `AI-Business-Value-Dashboard.pbit` in **Power BI Desktop**
2. When prompted for parameters, supply:
   - **Copilot Interactions File** → path to your Purview audit log CSV
   - **Copilot Licensed Users** → path to your licensed users CSV
   - **Org Data File** → path to your Entra org data CSV
   - **Agent 365** *(optional)* → path to Agent 365 export
3. Click **Load** — the model will refresh against your data
4. *(Optional)* Adjust slicers on the Overview page:
   - Hourly Salary (default $40 — adjust to your org's average)
   - Licence PPUM (default $30 — adjust to your blended licence cost)

</details>

---

## 🧮 How Value Is Calculated

Every Copilot interaction generates an audit signal — what app was used, what resources were accessed, what actions were taken. Each signal is classified into an **AI Task** (e.g., Email Drafting, Data Querying, Meeting Prep). Each task maps to a **Value Category**: either **Time Saved** (how much faster the work gets done) or **Augmented Skill** (specialist expertise AI provides that the user doesn't have). Each task carries a research-sourced human-time baseline — the hours a person would spend doing that work manually. The sum of these baselines is the **Hours Saved**. Multiply by an average hourly rate to get the **Assisted Value** — the dollar return on your AI investment.

**Signal → AI Task → Hours Saved / Augmented Skill → Assisted Value**

Maturity progresses through three **Frontier Firm patterns**: Pattern 1 (Human uses Copilot) → Pattern 2 (Human + Agent) → Pattern 3 (Agents run workflows). The **Autonomy Mix** cards show how your organisation's value is currently split across these patterns — and where the biggest growth opportunity lies.

---

## 📚 Dashboard Pages

| Page | Purpose |
|---|---|
| **Overview** | Executive summary — total hours saved, assisted value, weekly rhythm |
| **User Maturity** | User progression across 5 stages: Asking → Finding → Consuming → Producing → Automating |
| **Copilot Value** | Detailed Copilot usage, tasks, and value breakdown |
| **Agent Value** | Agent-specific tasks, shared agents, autonomous agent activity |
| **Agent Governance** | Agent deployment patterns, creator insights, sensitivity exposure |
| **Functional Value** | Value per business function, work archetype analysis, success metrics aligned to the Microsoft Frontier Firm scenario framework |
| **Adoption & Reach** | User counts, coverage %, licensed vs unlicensed |
| **Leaderboards** | Top users, agents, and functions |
| **Trends** | Time-series trends across all value metrics |
| **Signal > Behavior > Value** | Trace raw audit signals through to dollar value — defensibility and audit trail |
| **Glossary & Guide** | Metric definitions, methodology, and research sources |

---

## 🔬 Research Sources

Human-time baselines are sourced from published research including:
- Microsoft Research (Iqbal & Horvitz 2007; Branham & Brush 2015)
- Noy & Zhang (MIT/Science 2023)
- Brynjolfsson et al. (NBER 2023)
- BCG/Harvard (Dell'Acqua et al. 2023)
- McKinsey (2023)
- Forrester TEI (2022, 2024)
- IDC (2014, 2018, 2023)
- HDI, MetricNet, SHRM, Deloitte, Gartner (various)

See the **📖 Metric Glossary** table in the template for the full per-task source list.

---

## 🙏 Acknowledgements

- Microsoft Copilot Growth & ROI practice — for the core measurement framework
- The broader Microsoft community that shaped the AI-in-One Dashboard — this template builds on its structure

---

## 📝 License

MIT — see [LICENSE](LICENSE).
