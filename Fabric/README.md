# Fabric / Lakehouse deployment

The recommended path for tenants with **Fabric capacity** (or Premium / PPU). Heavy JSON parsing is moved out of the Power BI dataset and runs upstream in Fabric, so the dataset refresh becomes a near-instant data copy (or zero-copy with Direct Lake mode).

## What's in this folder

| File | Purpose |
|---|---|
| `AI-Business-Value-Dashboard-Fabric.pbit` | The Power BI template (thin client — sources from a Lakehouse SQL endpoint) |
| `notebooks/Copilot_Audit_Log_Parser.ipynb` | The PySpark notebook that parses raw audit logs into a flat Delta table |

## When to use this path

| Pick this path if… | Pick another path instead if… |
|---|---|
| You have Fabric capacity (F2+ or trial) | Power BI Pro only with no Fabric / Premium → use [`SharePoint Refresh`](../SharePoint%20Refresh/) or the csv-path PBIT at the repo root |
| Audit volume > 100K events / week | Audit volume is small enough to refresh in Power BI dataset directly |
| You want scheduled, hands-off ingestion | You're happy running scripts ad-hoc |
| You hit the 1 GB dataset cap or 2-hour refresh timeout in Service | Refresh has always succeeded for you |

## Why pre-parsing matters

The default templates parse the `AuditData` JSON column inside the Power BI dataset's M-query. That works for small/medium tenants, but at scale it triggers three Service-side limits:

1. **Memory cap** — Pro/shared workspaces cap the dataset at 1 GB; peak refresh memory can be 3× that during JSON expansion
2. **Refresh timeout** — 2 hours on shared, 5 hours on Premium
3. **Power Query firewall** — `Formula.Firewall` errors when combining queries from different sources

Moving the parse into Fabric eliminates all three. The dataset becomes a thin pass-through against an already-flat Delta table.

## Architecture

```
Raw audit-log CSVs (from scripts/get-copilot-interactions.ps1
                    or your own export pipeline)
                              ↓
                  Fabric Lakehouse: Files/audit_raw/
                              ↓
              Notebook: Copilot_Audit_Log_Parser.ipynb
                  (runs on schedule via Fabric pipelines)
                              ↓
       Lakehouse Delta table: dbo.Copilot_Interactions_Parsed
                              ↓
                    PBIT (Sql.Database connector)
                              ↓
                       Power BI Report
```

## Quick start

### 1. Stand up the Lakehouse

- Open a Fabric workspace assigned to a Fabric capacity (F2+ or trial)
- **+ New → Lakehouse**, name it e.g. `CopilotAnalytics`
- Note the **SQL endpoint** under Lakehouse settings — looks like `<workspace-guid>.datawarehouse.fabric.microsoft.com`

### 2. Land raw audit CSVs in `Files/audit_raw/`

The CSVs must have the standard Microsoft 365 audit-log columns:
`RecordId, CreationDate, RecordType, Operation, AuditData, AssociatedAdminUnits, AssociatedAdminUnitsNames`

| If your audit export goes to… | Use… |
|---|---|
| SharePoint folder | A **Fabric Pipeline** Copy activity (SharePoint Online → Lakehouse Files) |
| Azure Blob / ADLS Gen2 | A **Lakehouse Shortcut** to the storage container (no copy needed) |
| Local files | Direct upload via Fabric portal, or pipeline Copy activity |

The existing [`scripts/get-copilot-interactions.ps1`](../scripts/get-copilot-interactions.ps1) writes CSVs that drop in directly.

### 3. Import and run the parser notebook

- In your Fabric workspace → **+ New → Import notebook** → upload [`notebooks/Copilot_Audit_Log_Parser.ipynb`](notebooks/Copilot_Audit_Log_Parser.ipynb)
- Attach the notebook to your Lakehouse (top-left **+ Lakehouse** → select `CopilotAnalytics`)
- Click **Run all**. First run takes ~30–60 seconds for ~400K events
- Output: a Delta table `Copilot_Interactions_Parsed` in the Lakehouse Tables folder
- Configure **Schedule** (top of notebook) to match your audit-log export cadence (typically daily)

### 4. Connect the PBIT

- Open `AI-Business-Value-Dashboard-Fabric.pbit` in Power BI Desktop
- Supply the parameters when prompted:

| Parameter | Value |
|---|---|
| **Fabric SQL Endpoint** | `<workspace-guid>.datawarehouse.fabric.microsoft.com` |
| **Lakehouse Database** | `CopilotAnalytics` (or your chosen Lakehouse name) |
| Copilot Licensed Users | Path or SharePoint URL to your licensed-users CSV |
| Org Data File | Path or SharePoint URL to your org-data CSV |
| Optional ones | Leave blank |

- Click **Load**. Refresh should complete in seconds
- Publish to a Power BI workspace ideally **on the same Fabric capacity** so Direct Lake works without cross-capacity overhead

### 5. Schedule + secure the Service refresh

- Service → workspace → dataset Settings → **Data source credentials** → sign in to the SQL endpoint
- **Scheduled refresh** → enable, match the cadence to your notebook schedule

## Alternative platforms

The parsing logic in the notebook is plain PySpark — runs unchanged in any Spark environment.

### Azure Databricks

- Replace `Files/audit_raw/*.csv` with your DBFS or Unity Catalog volume path
- Replace `saveAsTable('Copilot_Interactions_Parsed')` with your catalog table name
- Connect the PBIT via the **Azure Databricks** connector — point it at the Databricks SQL warehouse hostname + HTTP path

### Azure Data Lake Gen2 (no Spark)

- Land CSVs in your ADLS container, then either:
  - **Use a Fabric Lakehouse Shortcut** to expose ADL as a Lakehouse table → use this Fabric path as-is, **or**
  - Use the **csv-path PBIT** at the repo root and point its `Copilot Interactions File` parameter at the `https://<account>.dfs.core.windows.net/...` URL

### Synapse / Azure SQL DB

- Run the parsing notebook (Synapse Spark pool) or any equivalent Python/SQL transform
- Land the result in a SQL table — the PBIT's `Sql.Database(...)` connector works against any SQL endpoint

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Refresh succeeds but interactions table is empty | Parsing notebook hasn't run yet, or failed silently | Check the notebook's last execution; run manually |
| `Login failed` / `cannot open database` | SQL endpoint hostname or database name wrong | Re-check Lakehouse settings page for the exact SQL endpoint string |
| `Formula.Firewall` error | Cross-source merge with privacy levels mismatched | Service → dataset Settings → Data source credentials → set **Privacy: None** for both sources |
| Only some columns populated | Microsoft added new fields to the audit schema | Update `audit_schema` in the notebook (cell 2) to include them, re-run |
| Refresh slow (more than a minute) | Dataset is in Import mode | Switch the workspace to a Fabric capacity and convert to **Direct Lake** for sub-second response |

## Schema reference

`Copilot_Interactions_Parsed` has one row per **prompt × accessed-resource**. Key columns:

| Column | Notes |
|---|---|
| `CreationDate` | Parsed from `AuditData.CreationTime` |
| `Audit_UserId` | The user's UPN (joined to the licensed-users + org tables) |
| `AppHost` | `Teams`, `Word`, `Excel`, `Copilot Studio`, etc. |
| `Workload` | Typically `Copilot` |
| `AISystemPlugin_Id` | `BingWebSearch` indicates Bing grounding was used |
| `AccessedResource_Type` | `WebSearchQuery`, `File`, `Email`, `EnterpriseSearch`, etc. |
| `Message_Id` / `Message_isPrompt` | One row per prompt; `Message_isPrompt = "TRUE"` always |
| `Resource_Count` | Original fan-out count |
| `InteractionDate` / `WeekStart` / `MonthStart` | Computed in PySpark |

For the full audit-log JSON schema see [Microsoft Learn — CopilotInteraction](https://learn.microsoft.com/en-us/office/office-365-management-api/copilot-schema).

## Customising the parser

The notebook's `audit_schema` cell defines which JSON fields get extracted. Add fields by extending that struct — the rest of the notebook adapts automatically as long as the new field is referenced in the `flat.select(...)` block.

For incremental refresh (only parse new events since the last run), change `WRITE_MODE` to `'append'` and add a watermark filter on `CreationTime` keyed off the max value already in the Delta table.
