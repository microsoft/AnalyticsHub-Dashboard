# Performance notes

## Template file size

The current `.pbit` weighs ~41 MB — larger than you'd expect for a template. The cause:

- **Semantic model**: only ~3.9 MB (small, fine)
- **Custom visuals bundled inside the template**: ~122 MB uncompressed (~37 MB compressed)

The template has **19 custom visuals** registered, several of which are no longer used in any page:

| Unused visual | Approx size | Notes |
|---|---|---|
| `chatpowerbi_ai` | 2.1 MB | Registered, not placed on any page |
| `histogram (F963F133)` | 2.0 MB | Registered, not placed |
| `animatedtreemap` | 689 KB | Registered, not placed |
| `StackedBarLine` | 497 KB | Registered, not placed |
| `sankey (02300D1B)` | 401 KB | Registered, not placed |

**Total cleanup potential: ~5–6 MB** just from removing unused visuals.

### How to clean up

1. Open `AI-Business-Value-Dashboard.pbit` in Power BI Desktop
2. **View ribbon → Visualizations pane → More options → Get more visuals**
3. Go to **My visuals** → review each custom visual
4. Remove any you don't use (especially the five listed above)
5. **File → Save as Power BI template (.pbit)**

Expected result: ~35 MB (20% reduction), still functional.

### Further size reduction

If the template needs to be even smaller (e.g. for sharing via email):

- **Replace third-party Inforiver Charts (~20 MB)** with native Power BI matrix visuals where possible. Inforiver is the single biggest custom visual; its advanced features aren't needed on every page.
- **Lollipop chart (~15 MB)** — native bar chart with a thin bar achieves similar effect.
- **Network graph (~10 MB)** — used for the Signal → Behavior → Value page; consider replacing with a Sankey from a smaller visual library.

Potential further reduction: another 30–40 MB if Inforiver is removed.

## Runtime performance

See [AI Fluency Dashboard optimisation notes](https://github.com/Keithland89/AI-Business-Value-Dashboard/issues) for runtime performance work in progress:

- Auto-date/time should be disabled (deletes 9 hidden LocalDateTable hierarchies)
- `User_Stage_Maturity` calculated column already optimised (single table scan instead of 3 LOOKUPVALUEs)
- `Total Users` / `Org Count` on `Agents 365` are still evaluated at refresh time — precomputing in Power Query would be faster for very large audit logs
