// @ts-check
/**
 * Reads a semantic model's workspace and model IDs from the link people copy in Power BI or Fabric, so
 * nobody has to find the IDs or paste them into JSON. It takes the shapes both portals and the REST API
 * use, on any host:
 *
 *   https://app.powerbi.com/groups/<workspace>/datasets/<model>/details
 *   https://app.powerbi.com/groups/<workspace>/settings/datasets/<model>
 *   https://app.fabric.microsoft.com/groups/<workspace>/semanticmodels/<model>?ctid=<tenant>
 *   https://api.powerbi.com/v1.0/myorg/groups/<workspace>/datasets/<model>
 *
 * Like every module in this folder, it imports only Node built-ins and its siblings, so it runs straight
 * from a downloaded ZIP.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const MODEL_SEGMENTS = new Set(['datasets', 'semanticmodels', 'modeling']);
const REPORT_SEGMENTS = new Set(['reports', 'rdlreports', 'dashboards']);

const NOT_A_LINK = 'That isn\'t a link. Open the semantic model in Power BI or Fabric, and copy the link from the address bar.';
const NOT_A_MODEL = 'That isn\'t a semantic model link. Open the semantic model in Power BI or Fabric, and copy the link from the address bar.';
const MY_WORKSPACE = 'That model is in My workspace, which other people can\'t read from. Use a model in a shared workspace.';
const REPORT = 'That\'s a report link. Open its semantic model, and copy that link instead.';

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export const isGuid = (value) => typeof value === 'string' && GUID.test(value);

/** @typedef {{ workspaceId: string, itemId: string }} ModelRef */
/** @typedef {({ ok: true } & ModelRef) | { ok: false, error: string }} LinkResult */

/**
 * @param {string | undefined} text  What was pasted.
 * @returns {LinkResult}
 */
export function parseModelLink(text) {
  const trimmed = String(text ?? '').trim().replace(/^[<"'`\s]+|[>"'`\s]+$/g, '');
  if (!trimmed) return { ok: false, error: 'Paste the model\'s link.' };
  /** @type {URL} */
  let url;
  try {
    url = new URL(SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: NOT_A_LINK };
  }
  if (url.protocol !== 'https:') return { ok: false, error: NOT_A_LINK };

  const segments = url.pathname.split('/').filter(Boolean).map(decode);
  const groups = segments.indexOf('groups');
  if (groups < 0 || groups + 1 >= segments.length) return { ok: false, error: NOT_A_MODEL };
  const workspace = segments[groups + 1];
  if (workspace === 'me') return { ok: false, error: MY_WORKSPACE };
  if (!isGuid(workspace)) return { ok: false, error: NOT_A_MODEL };

  let at = groups + 2;
  if (segments[at] === 'settings') at++;
  const kind = segments[at];
  if (REPORT_SEGMENTS.has(kind)) return { ok: false, error: REPORT };
  const item = segments[at + 1];
  if (!MODEL_SEGMENTS.has(kind) || !isGuid(item)) return { ok: false, error: NOT_A_MODEL };
  return { ok: true, workspaceId: workspace, itemId: item };
}

/** @param {string} segment */
function decode(segment) {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}
