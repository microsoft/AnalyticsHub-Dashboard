import { readFile } from 'node:fs/promises';
import { X509Certificate, createHash } from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { ManagedIdentityCredential } from '@azure/identity';
import { ConfidentialClientApplication } from '@azure/msal-node';

const USER_ROLE = 'AnalyticsHub.User';
const ADMIN_ROLE = 'AnalyticsHub.Admin';

export function parseBearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header || '');
  return match?.[1] || null;
}

export function createJwtVerifier(config) {
  const jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`));
  const issuers = [`https://login.microsoftonline.com/${config.tenantId}/v2.0`, `https://sts.windows.net/${config.tenantId}/`];
  const audiences = [config.appIdUri, config.webClientId].filter(Boolean);
  return async function verifyToken(token) {
    const { payload } = await jwtVerify(token, jwks, { issuer: issuers, audience: audiences });
    return payload;
  };
}

export function hasAccessScope(claims) { return String(claims.scp || '').split(/\s+/).includes('access_as_user'); }
export function getRoles(claims) { return (Array.isArray(claims.roles) ? claims.roles : []).map(String); }
export function hasUserRole(claims) { const roles = getRoles(claims); return roles.includes(USER_ROLE) || roles.includes(ADMIN_ROLE); }
export function hasAdminRole(claims) { return getRoles(claims).includes(ADMIN_ROLE); }
export function userIdFromClaims(claims) { return String(claims.oid || claims.sub || claims.preferred_username || claims.upn || 'unknown'); }
export function userNameFromClaims(claims) { return String(claims.preferred_username || claims.upn || claims.name || userIdFromClaims(claims)); }

/** A cached token is dropped this long before it, or the caller's token it came from, expires. */
export const OBO_TOKEN_SKEW_MS = 5 * 60 * 1000;
/**
 * A cached token is used for at most this long after its exchange began. Once Entra stops issuing a user tokens (their
 * account is disabled or their sessions are revoked), the app stops using the ones it holds for them within this time.
 */
export const OBO_TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
export const OBO_CACHE_MAX_ENTRIES = 2000;
const OBO_CACHE_SWEEP_MS = 60 * 1000;

/**
 * Exchanges the caller's token for a Power BI or Graph token on their behalf (OBO), with one MSAL client per process.
 *
 * Tokens are reused per caller token and scopes. The cache key is a SHA-256 of the caller's token plus the scopes, never
 * the token itself, so one caller's token is never handed to another. An entry is used for at most OBO_TOKEN_MAX_AGE_MS after
 * its exchange began, and never past OBO_TOKEN_SKEW_MS before the downstream token or the caller's token expires; a caller's
 * token with no readable expiry is never cached. The cache holds at most maxEntries, least recently used out first, and
 * expired entries are swept as it's used.
 * Concurrent requests for the same key share one exchange. A non-empty claims challenge always goes to Entra.
 *
 * MSAL's own token cache is skipped (skipCache) and emptied after every exchange, so it can't grow as tokens rotate; it
 * keeps only the tenant's endpoint metadata. Nothing here logs a token, a caller's token or a hash of either.
 *
 * The second argument is the caller's verified claims, kept for the existing call shape. It isn't a claims challenge.
 */
export function createOboTokenAcquirer(config, { credential, createClient = (clientConfig) => new ConfidentialClientApplication(clientConfig), maxEntries = OBO_CACHE_MAX_ENTRIES } = {}) {
  const authority = `https://login.microsoftonline.com/${config.tenantId}`;
  const managedIdentity = credential || (config.azureClientId ? new ManagedIdentityCredential(config.azureClientId) : null);
  const tokens = new Map();
  const inflight = new Map();
  let clientPromise = null;
  let nextSweepAt = 0;

  async function getClientAssertion() {
    if (!managedIdentity) throw new Error('AZURE_CLIENT_ID is required for managed identity OBO');
    const token = await managedIdentity.getToken('api://AzureADTokenExchange/.default');
    if (!token?.token) throw new Error('Managed identity token acquisition failed');
    return token.token;
  }
  async function readCertificate(certPath) {
    const pem = await readFile(certPath, 'utf8');
    const certMatch = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem);
    if (!certMatch) throw new Error('VALUELENS_WEB_CLIENT_CERT_PATH must contain a PEM certificate');
    const cert = new X509Certificate(certMatch[0]);
    return { privateKey: pem, thumbprintSha256: createHash('sha256').update(cert.raw).digest('hex').toUpperCase() };
  }
  function getClient() {
    if (!clientPromise) {
      const promise = (async () => {
        const cert = config.webClientCertPath ? await readCertificate(config.webClientCertPath) : null;
        return createClient({
          auth: cert
            ? { clientId: config.webClientId, authority, clientCertificate: cert }
            : { clientId: config.webClientId, authority, clientAssertion: getClientAssertion }
        });
      })();
      clientPromise = promise;
      promise.catch(() => { if (clientPromise === promise) clientPromise = null; });
    }
    return clientPromise;
  }
  async function exchange(userJwt, scopes, claims) {
    const client = await getClient();
    try {
      const result = await client.acquireTokenOnBehalfOf({ oboAssertion: userJwt, scopes, skipCache: true, ...(claims ? { claims } : {}) });
      if (!result?.accessToken) throw new Error('OBO token acquisition failed');
      return result;
    } finally {
      client.clearCache();
    }
  }
  function sweep(now) {
    if (now < nextSweepAt) return;
    nextSweepAt = now + OBO_CACHE_SWEEP_MS;
    for (const [key, entry] of tokens) if (entry.expiresAt <= now) tokens.delete(key);
  }
  function cached(key) {
    const now = Date.now();
    sweep(now);
    const entry = tokens.get(key);
    if (!entry) return null;
    tokens.delete(key);
    if (entry.expiresAt <= now) return null;
    tokens.set(key, entry);
    return entry.accessToken;
  }
  function remember(key, userJwt, result, startedAt) {
    const now = Date.now();
    const expiresOn = result.expiresOn ? new Date(result.expiresOn).getTime() : NaN;
    const refreshOn = result.refreshOn ? new Date(result.refreshOn).getTime() : Infinity;
    // NaN (no readable expiry) carries through Math.min, so such a token isn't kept.
    const expiresAt = Math.min(startedAt + OBO_TOKEN_MAX_AGE_MS, Math.min(expiresOn, refreshOn, assertionExpiresAt(userJwt)) - OBO_TOKEN_SKEW_MS);
    tokens.delete(key);
    if (!(expiresAt > now)) return;
    tokens.set(key, { accessToken: result.accessToken, expiresAt });
    sweep(now);
    while (tokens.size > maxEntries) tokens.delete(tokens.keys().next().value);
  }

  async function acquireOboToken(userJwt, _claims, scopes = POWER_BI_SCOPES, { claimsChallenge } = {}) {
    if (typeof userJwt !== 'string' || !userJwt) throw new Error('OBO needs the caller\'s token');
    const key = oboCacheKey(userJwt, scopes);
    const challenge = normalizeClaimsChallenge(claimsChallenge);
    if (challenge) {
      tokens.delete(key);
    } else {
      const hit = cached(key);
      if (hit) return hit;
      if (inflight.has(key)) return inflight.get(key);
    }
    // A challenge supersedes any exchange already in flight for this key: that one's token is returned to its callers but not kept.
    const startedAt = Date.now();
    const promise = exchange(userJwt, scopes, challenge).then((result) => {
      if (inflight.get(key) === promise) remember(key, userJwt, result, startedAt);
      return result.accessToken;
    });
    inflight.set(key, promise);
    const settle = () => { if (inflight.get(key) === promise) inflight.delete(key); };
    promise.then(settle, settle);
    return promise;
  }
  /** Drops the token for this caller's token and scopes, so the next request exchanges again. */
  acquireOboToken.forget = (userJwt, scopes = POWER_BI_SCOPES) => {
    if (typeof userJwt !== 'string' || !userJwt) return;
    const key = oboCacheKey(userJwt, scopes);
    tokens.delete(key);
    inflight.delete(key);
  };
  acquireOboToken.cacheSize = () => tokens.size;
  return acquireOboToken;
}

function oboCacheKey(userJwt, scopes) {
  return `${createHash('sha256').update(userJwt).digest('base64url')} ${[...new Set(scopes)].sort().join(' ')}`;
}
function assertionExpiresAt(userJwt) {
  try {
    const { exp } = decodeJwt(userJwt);
    return typeof exp === 'number' ? exp * 1000 : NaN;
  } catch { return NaN; }
}
/** '' for no challenge; MSAL also treats '{}' as none. Anything else, even text that isn't JSON, skips the cache. */
function normalizeClaimsChallenge(challenge) {
  if (challenge == null) return '';
  const text = (typeof challenge === 'string' ? challenge : JSON.stringify(challenge) ?? '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Object.keys(parsed).length) return '';
  } catch { /* not JSON: still a challenge */ }
  return text;
}
export const POWER_BI_SCOPES = ['https://analysis.windows.net/powerbi/api/.default'];
export const GRAPH_SCOPES = ['https://graph.microsoft.com/.default'];
export { USER_ROLE, ADMIN_ROLE };
