// @ts-check
/** Read-only probes of the sources used by Fabric's Auto audit ingestion. */
import { createClient } from '../http.js';

/**
 * @param {(scope: `https://${string}/.default`) => Promise<string>} getToken
 * @param {string} tenantId
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function auditSourcesApi(getToken, tenantId, options = {}) {
  const graph = createClient({ ...options, baseUrl: 'https://graph.microsoft.com/v1.0', getToken: () => getToken('https://graph.microsoft.com/.default') });
  const feed = createClient({ ...options, baseUrl: `https://manage.office.com/api/v1.0/${encodeURIComponent(tenantId)}/activity/feed`, getToken: () => getToken('https://manage.office.com/.default') });
  return {
    /** @param {Date} start @param {Date} end */
    async sentinel(start, end) {
      const { data } = await graph.request('POST', '/security/runHuntingQuery', { body: {
        Query: `CopilotActivity | where TimeGenerated >= datetime(${start.toISOString()}) and TimeGenerated < datetime(${end.toISOString()}) | where tostring(RecordType) in ("CopilotInteraction", "261") | take 1`,
        Timespan: `${start.toISOString()}/${end.toISOString()}`,
      } });
      if (!Array.isArray(data?.results) || data.results.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new Error('Sentinel returned invalid result rows.');
      }
      return { records: data.results.length };
    },
    /** @param {Date} start @param {Date} end @param {boolean} live */
    async feed(start, end, live) {
      const { data } = await feed.request('GET', '/subscriptions/list');
      if (!Array.isArray(data)) throw new Error('The Management Activity API returned no subscription list.');
      const enabled = data.some((s) => s.contentType === 'Audit.General' && s.status === 'enabled');
      if (!enabled || !live) return { enabled };
      // One bounded listing proves content access without downloading non-Copilot audit data.
      const content = await feed.request('GET', '/subscriptions/content', { query: {
        contentType: 'Audit.General', startTime: start.toISOString().slice(0, 19), endTime: end.toISOString().slice(0, 19),
      } });
      if (!Array.isArray(content.data)) throw new Error('The Management Activity API returned no content list.');
      return { enabled, blobs: content.data.length };
    },
  };
}

/** @typedef {ReturnType<typeof auditSourcesApi>} AuditSourcesApi */
