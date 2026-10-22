import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, request, authHeader } from './helpers.js';
import { parseAccess } from '../src/config.js';
import { GRAPH_SCOPES } from '../src/auth.js';

const ACCESS = { groupId: 'group-1', groupName: 'Analytics Hub viewers', contact: 'admin@example.com' };
const NEW_USER = '22222222-2222-4222-8222-222222222222';
/** Found only by their email address, which isn't their sign-in name. */
const ALIAS = { id: '33333333-3333-4333-8333-333333333333', displayName: 'Alias Person', mail: 'alias@example.com', userPrincipalName: 'alias.person@example.com' };
const json = (body, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A small Graph: one viewer group owned by owner-1, with one member. Records every call.
 * denyLookups: the app may change the group but not look people or groups up, as before it had User.ReadBasic.All.
 */
function fakeGraph({ overageMember = true, denyWrites = false, denyLookups = false } = {}) {
  const calls = [];
  const members = [{ '@odata.type': '#microsoft.graph.user', id: 'viewer-1', displayName: 'Viewer', userPrincipalName: 'viewer@example.com' }];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    calls.push({ method, path: u.pathname, search: decodeURIComponent(u.search), auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (u.hostname === 'api.powerbi.com') return json({ error: { code: 'PowerBINotAuthorizedException' } }, 403);
    const p = u.pathname.replace('/v1.0', '');
    if (p === '/me/checkMemberGroups') return json({ value: overageMember ? ['group-1'] : [] });
    if (p === '/groups/group-1/owners') return json({ value: [{ '@odata.type': '#microsoft.graph.user', id: 'owner-1', displayName: 'Owner', userPrincipalName: 'owner@example.com' }] });
    if (p === '/groups/group-1/members') return json({ value: members });
    if (p === '/groups/group-1') return json({ displayName: 'Analytics Hub viewers' });
    if (denyLookups && (p.startsWith('/users') || p === '/groups')) return json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } }, 403);
    if (p === '/users/new%40example.com' || p === '/users/new@example.com') return json({ id: NEW_USER, displayName: 'New Person', userPrincipalName: 'new@example.com' });
    if (p.startsWith('/users/')) return json({ error: { message: 'Not found' } }, 404);
    if (p === '/users') return json({ value: decodeURIComponent(u.search).includes(`mail eq '${ALIAS.mail}'`) ? [ALIAS] : [] });
    if (p === '/groups') return json({ value: [] });
    if (denyWrites) return json({ error: { message: 'Insufficient privileges to complete the operation.' } }, 403);
    if (p === '/groups/group-1/members/$ref' && method === 'POST') return json(undefined, 204);
    if (p.startsWith('/groups/group-1/members/') && method === 'DELETE') return json(undefined, 204);
    return json({ error: { message: `unexpected ${method} ${p}` } }, 500);
  };
  return { calls, fetchImpl };
}

async function withServer(options, run) {
  const { server, baseUrl } = await startTestServer({ config: { access: ACCESS }, tokenAcquirer: async (_t, _c, scopes) => (scopes?.[0]?.includes('graph') ? 'graph-token' : 'powerbi-token'), ...options });
  try { await run(baseUrl); } finally { server.close(); }
}

test('access config: only a group id switches it on, and request links must be https', () => {
  assert.equal(parseAccess(''), null);
  assert.equal(parseAccess('{"contact":"a@b.c"}'), null);
  assert.deepEqual(parseAccess(JSON.stringify({ ...ACCESS, requestUrl: 'http://insecure.example' })), ACCESS);
  assert.deepEqual(parseAccess(JSON.stringify({ groupId: 'g', requestUrl: 'https://forms.example/x' })), { groupId: 'g', requestUrl: 'https://forms.example/x' });
});

test('the app config tells the app the group and who to ask', async () => {
  await withServer({}, async (baseUrl) => {
    assert.deepEqual((await (await request(baseUrl, '/app.config.json')).json()).access, ACCESS);
  });
});

test('the app config says when org-scoped access is on, with the org attribute it filters on', async () => {
  const scoped = { ...ACCESS, rlsOrgAttribute: 'department' };
  await withServer({ config: { access: scoped } }, async (baseUrl) => {
    assert.deepEqual((await (await request(baseUrl, '/app.config.json')).json()).access, scoped);
  });
});

test('viewers get in through a role or the group; anyone else gets NotAViewer', async () => {
  const graph = fakeGraph({ overageMember: false });
  await withServer({ fetchImpl: graph.fetchImpl }, async (baseUrl) => {
    for (const token of ['user', 'admin', 'group']) assert.equal((await request(baseUrl, '/api/settings/CommercialTerms', { headers: authHeader(token) })).status, 200, token);
    const denied = await request(baseUrl, '/api/settings/CommercialTerms', { headers: authHeader('norole') });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'NotAViewer');
    assert.equal((await request(baseUrl, '/api/settings/CommercialTerms', { headers: authHeader('overage') })).status, 403);
  });
});

test('with too many groups for the token, membership is checked once with Graph, then cached', async () => {
  const graph = fakeGraph();
  await withServer({ fetchImpl: graph.fetchImpl }, async (baseUrl) => {
    for (let i = 0; i < 2; i++) assert.equal((await request(baseUrl, '/api/settings/CommercialTerms', { headers: authHeader('overage') })).status, 200);
    const checks = graph.calls.filter((c) => c.path.endsWith('/me/checkMemberGroups'));
    assert.equal(checks.length, 1);
    assert.deepEqual(checks[0].body, { groupIds: ['group-1'] });
    assert.equal(checks[0].auth, 'Bearer graph-token');
  });
});

test('without a group, only the app roles let people in', async () => {
  await withServer({ config: { access: null } }, async (baseUrl) => {
    assert.equal((await request(baseUrl, '/api/settings/CommercialTerms', { headers: authHeader('group') })).status, 403);
    assert.equal((await (await request(baseUrl, '/app.config.json')).json()).access, undefined);
    assert.deepEqual(await (await request(baseUrl, '/api/access', { headers: authHeader('admin') })).json(), { group: null, canManage: false });
  });
});

test('viewers see the group; admins and owners also see and manage who is in it', async () => {
  const graph = fakeGraph();
  await withServer({ fetchImpl: graph.fetchImpl }, async (baseUrl) => {
    assert.deepEqual(await (await request(baseUrl, '/api/access', { headers: authHeader('group') })).json(), { group: { id: 'group-1', name: 'Analytics Hub viewers' }, canManage: false });
    for (const token of ['admin', 'owner']) {
      const body = await (await request(baseUrl, '/api/access', { headers: authHeader(token) })).json();
      assert.equal(body.canManage, true, token);
      assert.deepEqual(body.members, [{ id: 'viewer-1', name: 'Viewer', email: 'viewer@example.com', kind: 'user' }]);
      assert.deepEqual(body.owners.map((o) => o.id), ['owner-1']);
    }
    // Graph returns members' names and emails only when asked for them, and the app may read people's basic profiles.
    const lists = graph.calls.filter((c) => c.path.endsWith('/groups/group-1/members'));
    assert.ok(lists.length && lists.every((c) => c.search.includes('$select=id,displayName,userPrincipalName,mail')));
  });
});

test('admins add people by email and remove them by id; others cannot', async () => {
  const graph = fakeGraph();
  await withServer({ fetchImpl: graph.fetchImpl }, async (baseUrl) => {
    const post = (token, name) => request(baseUrl, '/api/access/members', { method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const refused = await post('group', 'new@example.com');
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, 'NotAccessManager');

    const added = await post('admin', 'new@example.com');
    assert.equal(added.status, 201);
    assert.deepEqual(await added.json(), { id: NEW_USER, name: 'New Person', email: 'new@example.com', kind: 'user' });
    const ref = graph.calls.find((c) => c.method === 'POST' && c.path.endsWith('/groups/group-1/members/$ref'));
    assert.deepEqual(ref.body, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${NEW_USER}` });

    const missing = await post('admin', 'Nobody Team');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'PrincipalNotFound');

    assert.equal((await request(baseUrl, `/api/access/members/${NEW_USER}`, { method: 'DELETE', headers: authHeader('owner') })).status, 204);
    assert.ok(graph.calls.some((c) => c.method === 'DELETE' && c.path.endsWith(`/groups/group-1/members/${NEW_USER}/$ref`)));
    assert.equal((await request(baseUrl, '/api/access/members/not-an-id', { method: 'DELETE', headers: authHeader('admin') })).status, 400);
  });
});

test('a person is found by their email address when it isn\'t their sign-in name', async () => {
  const graph = fakeGraph();
  await withServer({ fetchImpl: graph.fetchImpl }, async (baseUrl) => {
    const added = await request(baseUrl, '/api/access/members', { method: 'POST', headers: { ...authHeader('owner'), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ALIAS.mail }) });
    assert.equal(added.status, 201);
    assert.deepEqual(await added.json(), { id: ALIAS.id, name: 'Alias Person', email: 'alias.person@example.com', kind: 'user' });
    const ref = graph.calls.find((c) => c.method === 'POST' && c.path.endsWith('/groups/group-1/members/$ref'));
    assert.deepEqual(ref.body, { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${ALIAS.id}` });
  });
});

test('when Entra refuses a change, the app says only owners and directory admins can make it', async () => {
  const graph = fakeGraph({ denyWrites: true });
  await withServer({ fetchImpl: graph.fetchImpl }, async (baseUrl) => {
    const response = await request(baseUrl, `/api/access/members/${NEW_USER}`, { method: 'DELETE', headers: authHeader('admin') });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'AccessManageDenied');
    // The person was found, so it's the change to the group that was refused.
    const added = await request(baseUrl, '/api/access/members', { method: 'POST', headers: { ...authHeader('admin'), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'new@example.com' }) });
    assert.equal(added.status, 403);
    const { error } = await added.json();
    assert.equal(error.code, 'AccessManageDenied');
    assert.match(error.message, /Only owners of the viewer group and directory admins can change its members/);
  });
});

test("when Entra won't let the app look people or groups up, Share says so and how to fix it", async () => {
  const forgotten = [];
  const tokenAcquirer = async (_t, _c, scopes) => (scopes?.[0]?.includes('graph') ? 'graph-token' : 'powerbi-token');
  tokenAcquirer.forget = (token, scopes) => forgotten.push([token, scopes]);
  const graph = fakeGraph({ denyLookups: true });
  await withServer({ fetchImpl: graph.fetchImpl, tokenAcquirer }, async (baseUrl) => {
    const post = (token, name) => request(baseUrl, '/api/access/members', { method: 'POST', headers: { ...authHeader(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    for (const [token, name, what] of [['admin', 'new@example.com', /look up people by email/], ['owner', 'Sales Team', /look up groups by name/]]) {
      const response = await post(token, name);
      assert.equal(response.status, 403, name);
      const { error } = await response.json();
      assert.equal(error.code, 'LookupDenied', name);
      assert.match(error.message, what);
      assert.match(error.message, /run the installer again and choose Repair or change/);
      assert.match(error.message, /admin consent/);
      assert.doesNotMatch(error.message, /Only owners/);
    }
    assert.ok(!graph.calls.some((c) => c.method === 'POST' && c.path.endsWith('/members/$ref')), 'nobody is added');
    // After a Repair, the next try exchanges a fresh token with the new permission.
    assert.deepEqual(forgotten, [['admin', GRAPH_SCOPES], ['owner', GRAPH_SCOPES]]);
  });
});

test('a Power BI refusal reaches the app as PowerBIAccessDenied', async () => {
  const graph = fakeGraph();
  await withServer({ fetchImpl: graph.fetchImpl }, async (baseUrl) => {
    const response = await request(baseUrl, '/api/query', { method: 'POST', headers: { ...authHeader('group'), 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'workspace-1', itemId: 'dataset-1', query: 'EVALUATE ROW("x", 1)' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'PowerBIAccessDenied');
  });
});

test('a token Power BI or Graph refuses is dropped, so the next call exchanges a fresh one', async () => {
  const forgotten = [];
  const tokenAcquirer = async (_t, _c, scopes) => (scopes?.[0]?.includes('graph') ? 'graph-token' : 'powerbi-token');
  tokenAcquirer.forget = (token, scopes) => forgotten.push([token, scopes]);
  await withServer({ fetchImpl: fakeGraph({ denyWrites: true }).fetchImpl, tokenAcquirer }, async (baseUrl) => {
    const query = await request(baseUrl, '/api/query', { method: 'POST', headers: { ...authHeader('group'), 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'workspace-1', itemId: 'dataset-1', query: 'EVALUATE ROW("x", 1)' }) });
    assert.equal(query.status, 403);
    assert.deepEqual(forgotten, [['group', undefined]]);
    assert.equal((await request(baseUrl, `/api/access/members/${NEW_USER}`, { method: 'DELETE', headers: authHeader('admin') })).status, 403);
    assert.deepEqual(forgotten, [['group', undefined], ['admin', GRAPH_SCOPES]]);
  });
});
