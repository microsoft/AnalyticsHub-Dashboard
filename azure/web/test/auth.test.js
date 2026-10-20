import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { decodeJwt, jwtVerify } from 'jose';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { GRAPH_SCOPES, OBO_TOKEN_MAX_AGE_MS, OBO_TOKEN_SKEW_MS, POWER_BI_SCOPES, createOboTokenAcquirer } from '../src/auth.js';
import { testConfig } from './helpers.js';

const TENANT = 'tenant-id';
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`;
const TOKEN_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/token`;
const CLIENT_ID = testConfig().webClientId;
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const START = Date.UTC(2026, 0, 1);

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsignedJwt = (payload) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.c2ln`;
let callerTokens = 0;

/** A caller's token for the API, as the app sends it. Only who it's for and when it expires matter here; null means no exp. */
function callerToken(oid, lifetimeSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  callerTokens += 1;
  return unsignedJwt({ aud: CLIENT_ID, iss: `${AUTHORITY}/v2.0`, tid: TENANT, oid, sub: `sub-${oid}`, scp: 'access_as_user', iat: now, ...(lifetimeSeconds === null ? {} : { exp: now + lifetimeSeconds }), uti: `token-${callerTokens}` });
}

/**
 * Entra as MSAL's network client sees it: the tenant's metadata, and a token endpoint that names each token after its caller.
 * whileExchanging runs as each exchange is answered, so a test can move its clock while one is in flight.
 */
function fakeEntra({ expiresIn = 3600, refreshIn, refuse = () => false, whileExchanging = () => {} } = {}) {
  const gets = [];
  const exchanges = [];
  const networkClient = {
    async sendGetRequestAsync(url) {
      gets.push(url);
      if (url.includes('/discovery/instance')) {
        return { status: 200, headers: {}, body: { tenant_discovery_endpoint: `${AUTHORITY}/v2.0/.well-known/openid-configuration`, 'api-version': '1.1', metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net', aliases: ['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com', 'sts.windows.net'] }] } };
      }
      if (url.endsWith('/.well-known/openid-configuration')) {
        return { status: 200, headers: {}, body: { issuer: `${AUTHORITY}/v2.0`, authorization_endpoint: `${AUTHORITY}/oauth2/v2.0/authorize`, token_endpoint: TOKEN_ENDPOINT, jwks_uri: `${AUTHORITY}/discovery/v2.0/keys`, end_session_endpoint: `${AUTHORITY}/oauth2/v2.0/logout` } };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async sendPostRequestAsync(url, options) {
      const form = new URLSearchParams(options.body);
      const exchange = { url, form, assertion: form.get('assertion'), scope: form.get('scope'), claims: form.get('claims') };
      exchanges.push(exchange);
      await new Promise((resolve) => setTimeout(resolve, 5));
      whileExchanging(exchange);
      if (refuse(exchange)) return { status: 400, headers: {}, body: { error: 'invalid_grant', error_description: 'AADSTS50013: Assertion failed signature validation.', error_codes: [50013] } };
      let caller = {};
      try { caller = decodeJwt(exchange.assertion); } catch { /* not a JWT */ }
      const oid = caller.oid || 'unknown';
      const now = Math.floor(Date.now() / 1000);
      return {
        status: 200, headers: {},
        body: {
          token_type: 'Bearer', scope: exchange.scope, expires_in: expiresIn, ext_expires_in: expiresIn, ...(refreshIn ? { refresh_in: refreshIn } : {}),
          access_token: `access-${oid}-${exchanges.length}`, refresh_token: `refresh-${exchanges.length}`,
          id_token: unsignedJwt({ aud: CLIENT_ID, iss: `${AUTHORITY}/v2.0`, tid: TENANT, oid, sub: `sub-${oid}`, iat: now, exp: now + 3600, ver: '2.0' }),
          client_info: b64({ uid: oid, utid: TENANT })
        }
      };
    }
  };
  return { gets, exchanges, networkClient };
}

function fakeCredential() {
  const scopes = [];
  return { scopes, async getToken(scope) { scopes.push(scope); return { token: 'managed-identity-assertion', expiresOnTimestamp: Date.now() + 3600_000 }; } };
}

/** The real acquirer and a real MSAL client, talking to fakeEntra. */
function acquirerFor(entra, { config = {}, credential = fakeCredential(), maxEntries } = {}) {
  const clients = [];
  const acquire = createOboTokenAcquirer(testConfig(config), {
    credential,
    createClient: (clientConfig) => {
      const client = new ConfidentialClientApplication({ ...clientConfig, system: { networkClient: entra.networkClient } });
      clients.push({ clientConfig, client });
      return client;
    },
    ...(maxEntries ? { maxEntries } : {})
  });
  return { acquire, clients, credential };
}

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const size = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) size.unshift(n % 256);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.from([0x80 | size.length, ...size]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

/** A self-signed certificate for a new RSA key, built by hand: Node reads certificates but doesn't make them. */
function selfSignedCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRsa = der(0x30, der(0x06, Buffer.from('2a864886f70d01010b', 'hex')), der(0x05));
  const name = der(0x30, der(0x31, der(0x30, der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('valuelens-web test')))));
  const validity = der(0x30, der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('491231235959Z')));
  const tbs = der(0x30, der(0x02, Buffer.from([1])), sha256WithRsa, name, validity, name, publicKey.export({ type: 'spki', format: 'der' }));
  const certDer = der(0x30, tbs, sha256WithRsa, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { certDer, certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

test('one MSAL client serves every exchange, a caller\'s token is reused, and later exchanges make no other requests', async () => {
  const entra = fakeEntra();
  const { acquire, clients } = acquirerFor(entra);
  const alice = callerToken('alice');
  const first = await acquire(alice, { oid: 'alice' });
  // MSAL has login.microsoftonline.com's endpoints built in. This guards against clearCache() costing a metadata request per exchange.
  const metadataRequests = entra.gets.length;
  assert.equal(await acquire(alice, { oid: 'alice' }), first);
  assert.equal(entra.exchanges.length, 1);
  assert.match(await acquire(callerToken('bob'), { oid: 'bob' }), /^access-bob-/);
  assert.match(await acquire(callerToken('carol'), { oid: 'carol' }, GRAPH_SCOPES), /^access-carol-/);
  assert.equal(entra.exchanges.length, 3);
  assert.equal(clients.length, 1);
  assert.equal(entra.gets.length, metadataRequests);
});

test('concurrent first requests from one caller share one exchange', async () => {
  const entra = fakeEntra();
  const { acquire } = acquirerFor(entra);
  const alice = callerToken('alice');
  const tokens = await Promise.all([1, 2, 3, 4].map(() => acquire(alice, {})));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(entra.exchanges.length, 1);
  assert.equal(await acquire(alice, {}), tokens[0]);
  assert.equal(entra.exchanges.length, 1);
});

test('two callers never share a token: nor do two tokens of one person, nor Power BI and Graph', async () => {
  const entra = fakeEntra();
  const { acquire } = acquirerFor(entra);
  const alice = callerToken('alice');
  const bob = callerToken('bob');
  const [forAlice, forBob] = await Promise.all([acquire(alice, {}), acquire(bob, {})]);
  assert.match(forAlice, /^access-alice-/);
  assert.match(forBob, /^access-bob-/);
  assert.deepEqual(entra.exchanges.map((e) => e.assertion).sort(), [alice, bob].sort());
  assert.equal(await acquire(bob, {}), forBob);
  assert.equal(await acquire(alice, {}), forAlice);
  assert.equal(entra.exchanges.length, 2);

  const aliceLater = callerToken('alice');
  const forAliceLater = await acquire(aliceLater, {});
  assert.notEqual(forAliceLater, forAlice);
  assert.equal(entra.exchanges.at(-1).assertion, aliceLater);

  const graphForAlice = await acquire(alice, {}, GRAPH_SCOPES);
  assert.notEqual(graphForAlice, forAlice);
  assert.match(entra.exchanges.at(-1).scope, /^https:\/\/graph\.microsoft\.com\/\.default /);
  assert.equal(await acquire(alice, {}, GRAPH_SCOPES), graphForAlice);
  assert.equal(await acquire(alice, {}, POWER_BI_SCOPES), forAlice);
  assert.equal(entra.exchanges.length, 4);
});

test('a token is used until five minutes before it, or the caller\'s token, expires', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  // Each lifetime here, less the five minutes, ends before OBO_TOKEN_MAX_AGE_MS is up, so it's the expiry that decides.
  const entra = fakeEntra({ expiresIn: 840 });
  const { acquire } = acquirerFor(entra);

  const alice = callerToken('alice', 7200);
  const forAlice = await acquire(alice, {});
  t.mock.timers.tick(840_000 - OBO_TOKEN_SKEW_MS - 1000);
  assert.equal(await acquire(alice, {}), forAlice);
  t.mock.timers.tick(2000);
  assert.notEqual(await acquire(alice, {}), forAlice);
  assert.equal(entra.exchanges.length, 2);

  const bob = callerToken('bob', 720);
  const forBob = await acquire(bob, {});
  t.mock.timers.tick(720_000 - OBO_TOKEN_SKEW_MS - 1000);
  assert.equal(await acquire(bob, {}), forBob);
  t.mock.timers.tick(2000);
  assert.notEqual(await acquire(bob, {}), forBob);
  assert.equal(entra.exchanges.length, 4);

  for (const caller of [callerToken('carol', null), callerToken('dave', OBO_TOKEN_SKEW_MS / 1000 - 10), 'not-a-jwt']) {
    const before = entra.exchanges.length;
    await acquire(caller, {});
    await acquire(caller, {});
    assert.equal(entra.exchanges.length, before + 2);
  }
});

test('a token Entra says to refresh early is used until five minutes before then', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const entra = fakeEntra({ expiresIn: 7200, refreshIn: 720 });
  const { acquire } = acquirerFor(entra);
  const alice = callerToken('alice', 7200);
  const forAlice = await acquire(alice, {});
  t.mock.timers.tick(720_000 - OBO_TOKEN_SKEW_MS - 1000);
  assert.equal(await acquire(alice, {}), forAlice);
  t.mock.timers.tick(2000);
  assert.notEqual(await acquire(alice, {}), forAlice);
});

test('a token is used for at most ten minutes after its exchange began, however long it and the caller\'s token last', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  let exchangeTakes = 0;
  const entra = fakeEntra({ expiresIn: 3600, whileExchanging: () => { if (exchangeTakes) t.mock.timers.tick(exchangeTakes); } });
  const { acquire } = acquirerFor(entra);
  const alice = callerToken('alice', 7200);
  for (const scopes of [POWER_BI_SCOPES, GRAPH_SCOPES]) {
    const first = await acquire(alice, {}, scopes);
    t.mock.timers.tick(OBO_TOKEN_MAX_AGE_MS - 1000);
    assert.equal(await acquire(alice, {}, scopes), first);
    t.mock.timers.tick(2000);
    const second = await acquire(alice, {}, scopes);
    assert.notEqual(second, first);
    // The next ten minutes count from the new exchange.
    t.mock.timers.tick(OBO_TOKEN_MAX_AGE_MS - 1000);
    assert.equal(await acquire(alice, {}, scopes), second);
    t.mock.timers.tick(2000);
    assert.notEqual(await acquire(alice, {}, scopes), second);
  }
  assert.equal(entra.exchanges.length, 6);

  // An exchange that takes 30 s leaves its token 9.5 minutes, so no token is used more than ten minutes after Entra was asked.
  exchangeTakes = 30_000;
  const bob = callerToken('bob', 7200);
  const forBob = await acquire(bob, {});
  exchangeTakes = 0;
  t.mock.timers.tick(OBO_TOKEN_MAX_AGE_MS - 30_000 - 1000);
  assert.equal(await acquire(bob, {}), forBob);
  t.mock.timers.tick(2000);
  assert.notEqual(await acquire(bob, {}), forBob);
  assert.equal(entra.exchanges.length, 8);
});

test('the cache holds at most maxEntries, dropping the least recently used, and sweeps out expired tokens', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const entra = fakeEntra({ expiresIn: 3600 });
  const { acquire } = acquirerFor(entra, { maxEntries: 2 });
  const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map((oid) => callerToken(oid, 7200));
  const forAlice = await acquire(alice, {});
  await acquire(bob, {});
  assert.equal(acquire.cacheSize(), 2);
  assert.equal(await acquire(alice, {}), forAlice);
  await acquire(carol, {});
  assert.equal(acquire.cacheSize(), 2);
  assert.equal(await acquire(alice, {}), forAlice);
  assert.equal(entra.exchanges.length, 3);
  await acquire(bob, {});
  assert.equal(entra.exchanges.length, 4);
  assert.equal(acquire.cacheSize(), 2);

  t.mock.timers.tick(3600_000);
  await acquire(dave, {});
  assert.equal(acquire.cacheSize(), 1);
});

test('a claims challenge always goes to Entra, and the token it gets replaces the cached one', async () => {
  const entra = fakeEntra();
  const { acquire } = acquirerFor(entra);
  const alice = callerToken('alice');
  const cached = await acquire(alice, {});
  for (const none of [undefined, null, '', '   ', '{}', {}]) assert.equal(await acquire(alice, {}, POWER_BI_SCOPES, { claimsChallenge: none }), cached);
  assert.equal(entra.exchanges.length, 1);

  const challenge = '{"access_token":{"nbf":{"essential":true,"value":"1767225600"}}}';
  const challenged = await acquire(alice, {}, POWER_BI_SCOPES, { claimsChallenge: challenge });
  assert.notEqual(challenged, cached);
  assert.equal(entra.exchanges.length, 2);
  // MSAL adds optional id_token claims of its own to the challenge it sends.
  assert.deepEqual(JSON.parse(entra.exchanges[1].claims).access_token, JSON.parse(challenge).access_token);
  assert.equal(entra.exchanges[0].claims, null);
  assert.equal(await acquire(alice, {}), challenged);

  await acquire(alice, {}, POWER_BI_SCOPES, { claimsChallenge: JSON.parse(challenge) });
  assert.equal(entra.exchanges.length, 3);
});

test('forget drops a caller\'s token for one set of scopes', async () => {
  const entra = fakeEntra();
  const { acquire } = acquirerFor(entra);
  const alice = callerToken('alice');
  const powerBi = await acquire(alice, {});
  const graph = await acquire(alice, {}, GRAPH_SCOPES);
  acquire.forget(alice);
  assert.equal(await acquire(alice, {}, GRAPH_SCOPES), graph);
  assert.notEqual(await acquire(alice, {}), powerBi);
  acquire.forget(alice, GRAPH_SCOPES);
  assert.notEqual(await acquire(alice, {}, GRAPH_SCOPES), graph);
  assert.equal(entra.exchanges.length, 4);
});

test('with a certificate, the one client signs every exchange with it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'valuelens-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cert = selfSignedCertificate();
  const certPath = path.join(dir, 'web-client.pem');
  await fs.writeFile(certPath, cert.keyPem + cert.certPem);
  const entra = fakeEntra();
  const { acquire, clients, credential } = acquirerFor(entra, { config: { webClientCertPath: certPath } });
  await acquire(callerToken('alice'), {});
  await acquire(callerToken('bob'), {});
  assert.equal(clients.length, 1);
  assert.equal(clients[0].clientConfig.auth.clientAssertion, undefined);
  assert.equal(credential.scopes.length, 0);
  assert.equal(entra.exchanges.length, 2);
  for (const { form } of entra.exchanges) {
    assert.equal(form.get('client_id'), CLIENT_ID);
    assert.equal(form.get('client_assertion_type'), JWT_BEARER);
    // MSAL rounds nbf to the nearest second, so it can be half a second ahead; Entra allows skew too.
    const { payload, protectedHeader } = await jwtVerify(form.get('client_assertion'), cert.publicKey, { algorithms: ['PS256'], clockTolerance: 5 });
    assert.equal(protectedHeader['x5t#S256'], createHash('sha256').update(cert.certDer).digest('base64url'));
    assert.equal(payload.aud, TOKEN_ENDPOINT);
    assert.equal(payload.iss, CLIENT_ID);
    assert.equal(payload.sub, CLIENT_ID);
  }
});

test('without a certificate, the managed identity\'s token is the client assertion for every exchange', async () => {
  const entra = fakeEntra();
  const { acquire, clients, credential } = acquirerFor(entra);
  await acquire(callerToken('alice'), {});
  await acquire(callerToken('bob'), {});
  assert.equal(clients.length, 1);
  assert.equal(clients[0].clientConfig.auth.clientCertificate, undefined);
  assert.deepEqual(credential.scopes, ['api://AzureADTokenExchange/.default', 'api://AzureADTokenExchange/.default']);
  for (const { url, form } of entra.exchanges) {
    assert.equal(url.split('?')[0], TOKEN_ENDPOINT);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(form.get('requested_token_use'), 'on_behalf_of');
    assert.equal(form.get('client_id'), CLIENT_ID);
    assert.equal(form.get('client_assertion'), 'managed-identity-assertion');
    assert.equal(form.get('client_assertion_type'), JWT_BEARER);
  }
});

test('MSAL keeps no tokens between exchanges, so its cache cannot grow', async () => {
  const refused = callerToken('mallory');
  const entra = fakeEntra({ refuse: ({ assertion }) => assertion === refused });
  const { acquire, clients } = acquirerFor(entra);
  for (const oid of ['alice', 'bob', 'carol']) {
    await acquire(callerToken(oid), {});
    await acquire(callerToken(oid), {}, GRAPH_SCOPES);
  }
  await assert.rejects(acquire(refused, {}));
  const cache = JSON.parse(clients[0].client.getTokenCache().serialize());
  for (const section of ['Account', 'IdToken', 'AccessToken', 'RefreshToken']) assert.deepEqual(cache[section] || {}, {}, section);
  assert.equal(acquire.cacheSize(), 6);
});

test('tokens, callers\' tokens and hashes of them reach neither errors nor the console, and a failed exchange is not kept', async (t) => {
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    t.mock.method(console, method, (...args) => logged.push(args.map((a) => (a instanceof Error ? `${a.stack} ${JSON.stringify(a)}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  }
  const alice = callerToken('alice');
  const refused = callerToken('mallory');
  const entra = fakeEntra({ refuse: ({ assertion }) => assertion === refused });
  const { acquire } = acquirerFor(entra);
  const issued = [await acquire(alice, {}), await acquire(alice, {}, GRAPH_SCOPES)];
  const errors = [];
  for (const caller of [refused, refused, '', undefined]) {
    await acquire(caller, {}).then(() => assert.fail('expected the exchange to fail'), (error) => errors.push(error));
  }
  assert.equal(entra.exchanges.filter((e) => e.assertion === refused).length, 2);
  acquire.forget(alice);
  const exposed = [...logged, ...errors.map((e) => `${e.message} ${e.stack} ${JSON.stringify(e)} ${String(e)}`)].join('\n');
  const hashes = [alice, refused].flatMap((jwt) => ['hex', 'base64url', 'base64'].map((encoding) => createHash('sha256').update(jwt).digest(encoding)));
  for (const secret of [alice, refused, ...issued, ...hashes]) assert.ok(!exposed.includes(secret), 'a token or a hash of one was exposed');
});
