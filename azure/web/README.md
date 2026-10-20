# web: Analytics Hub on Azure

`valuelens-web` is the Node 24 service for Analytics Hub on Azure. It serves the built SPA from `/app/public` (or `VALUELENS_PUBLIC_DIR`) and exposes the API on port `8080` (`PORT` overrides it).

## Routes

- `GET /app.config.json` returns Azure host configuration for the SPA and is never cached. Its `reporting` object carries the Value page's default currency and exchange rate from `VALUELENS_CURRENCY` (an ISO code, default `USD`) and `VALUELENS_EXCHANGE_RATE` (units of that currency per $1, optional). A currency or rate saved under **Prices** in the app overrides them. Its `modules` object says which optional modules the installer turned on, in `fabric.config.json`'s shape: `m365Activity`, `agent365`, `productFeedback`, `consumption`, `agentEvaluator`, `defender` and `resourceGraph`, each `true` when it's in `VALUELENS_MODULES`, the comma list the jobs read. Other IDs, such as `core` and `orgData`, are ignored. The app skips its checks for the modules that are off. Without `VALUELENS_MODULES`, `modules` is left out and the app checks every source.
- `GET /api/health` returns `{ "status": "ok", "version" }` for Container Apps probes.
- `POST /api/query` validates an Analytics Hub JWT, checks the configured semantic-model allow-list, gets a Power BI token on the user's behalf (OBO, see [Tokens on the user's behalf](#tokens-on-the-users-behalf)), and proxies `executeQueries` JSON verbatim. It coalesces identical requests, caches results per user for 10 minutes, limits each user to four upstream calls, and preserves 429 `Retry-After`.
- `POST /api/ask` answers a question (`{ question, history? }`) with Azure OpenAI, returning `{ answer, runs }`. It is on only when `VALUELENS_ASK_ENDPOINT` and `VALUELENS_ASK_DEPLOYMENT` are set, and then `/app.config.json` carries `ask: { mode: "chat" }`. The model can call only the named queries in `app/src/ask/catalogue.json` (copied to `VALUELENS_ASK_DIR` in the image), never its own DAX. Each query runs through the `/api/query` path, as the signed-in user, with only date and organization filters applied. Groups under 5 people are left out before the model sees a row, and at most 50 rows go to the model. Columns a catalogue entry lists under `omit`, such as the Executive summary's `People With Organization`, never reach it. A question gets at most 8 queries; each user gets 20 questions per 10 minutes and 2 at once. The web app reaches the model with its managed identity, which needs **Cognitive Services OpenAI User**. Logs keep the question and the query names, never the answer or the data.
- `GET/PUT/DELETE /api/settings/:entity[/:id]` stores `CommercialTerms`, `ReportPack` and `TaskTime` rows in Azure Table Storage table `appsettings` using managed identity. Writes require `AnalyticsHub.Admin` unless `VALUELENS_SETTINGS_WRITERS=all`.
- `GET /api/version` compares `VALUELENS_VERSION` with the stable releases of `microsoft/AnalyticsHub-Dashboard` tagged `installer-v`, `analytics-hub-azure-v` or `v`.
- `GET/POST /api/delegations`, `DELETE /api/delegations/:id` and `POST /api/delegations/:id/approve` back scoped delegation in the Share panel when org-scoped access (row-level security) is on. They read and write `dbo.access_scope` in Azure SQL (`VALUELENS_SQL_SERVER`, `VALUELENS_SQL_DATABASE`) as the managed identity, writing only rows with `GrantedVia = 'share'`. The jobs' access step leaves those rows alone. Adding someone to the viewer group goes through Graph as the signed-in user. When they can't do that, the scope waits for an admin to approve it. After a change, the service refreshes the model's `Access Scope` table as the managed identity: at most one refresh waits per model. When RLS is off, `GET` returns `{ "enabled": false }`.
- Other GETs serve static assets, with SPA fallback to `index.html` for HTML navigation requests. Text files go out as the Brotli or gzip copy the image build made, when the browser accepts it (see [Compression](#compression)).

Security headers, including a CSP `frame-ancestors` that lets Teams, Outlook and the Microsoft 365 Copilot app show the tab, are applied to all responses. The server intentionally does not set `X-Frame-Options`.

## Tokens on the user's behalf

`/api/query` and the Graph calls behind `/api/access`, `/api/delegations` and the viewer-group check exchange the caller's token for a Power BI or Graph token on their behalf (OBO). One MSAL client per process makes every exchange. It signs with the managed identity's federated credential (`AZURE_CLIENT_ID`), or with the certificate in `VALUELENS_WEB_CLIENT_CERT_PATH` when that's set. A token is reused for later requests that carry the same caller token and ask for the same scopes:

- The cache key is a SHA-256 of the caller's token plus the scopes, so one user's token never serves another's request, and the caller's token isn't kept as a key. Every request's token is verified before the cache is looked at.
- An entry is used for at most 10 minutes after its exchange, and never past 5 minutes before the Power BI or Graph token, or the caller's token, expires. A caller's token with no readable expiry is never cached. So a user whose account is disabled, or whose sessions are revoked in Entra, keeps Power BI and Graph access through the app for up to 10 minutes, and can reopen results loaded in that time for up to 10 minutes after each was fetched. An active user makes about one exchange every 10 minutes for each set of scopes.
- The token cache doesn't delay removing someone's workspace access or app role, because Power BI and Graph check permissions on every call. The app's own checks delay it, as they did before: the app role, and usually the viewer group, are read from the caller's token, so a removed one counts until that token expires (60 to 90 minutes by default), and results a user has already loaded are served from the result cache for up to 10 minutes after they were fetched.
- The cache holds at most 2,000 entries, least recently used out first, and drops expired ones as it's used. MSAL's own token cache is skipped and emptied after every exchange, so it doesn't grow.
- Requests that arrive together for the same token share one exchange. A claims challenge always goes to Entra. When Power BI or Graph refuses a token (401 or 403), it's dropped, so the next call exchanges again.
- Nothing logs a token, a caller's token or a hash of either.

## Compression

- JSON responses of 1 KB or more, including `/api/query` results, go out with Brotli (quality 4) or gzip (level 6) when the request accepts it. Results are cached uncompressed, so each response matches its own request's `Accept-Encoding`.
- Static text files (HTML, JavaScript, CSS, JSON and SVG) are compressed once, at the highest levels, when the image is built: `node src/precompress.js public` writes a `.br` and a `.gz` copy next to each one of 1 KB or more. The server sends the best copy the browser accepts and never compresses a static file itself. A copy whose modified time doesn't match its file's is ignored, so an edited file is never served from an old copy.
- Compressible responses carry `Vary: Accept-Encoding`. Other files, such as PNG images, icons and fonts, go out as they are. No route streams (there's no server-sent events), so nothing is held back by compression.

## Development

```powershell
cd "azure/web"
npm.cmd install
npm.cmd test
```

The Dockerfile is intended to be built from the repository root and produces a non-root `node:24-alpine` image that builds the Fabric SPA, copies its `dist` into `/app/public` and writes the compressed copies of its text files there. To serve compressed static files from a local build, run `node src/precompress.js <public dir>` after building the SPA, and again after changing it.
