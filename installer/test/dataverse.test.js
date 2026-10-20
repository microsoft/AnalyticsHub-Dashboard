// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataverseApi } from '../src/clients/dataverse.js';

/** A Dataverse Web API client whose requests are recorded. */
function recorded() {
  /** @type {{ method: string, path: string, opts: any }[]} */
  const requests = [];
  const http = { request: async (/** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ opts) => (requests.push({ method, path, opts }), null) };
  return { dv: dataverseApi(/** @type {any} */ (http), 'https://env.example.com/'), requests };
}

test('Dataverse: taking a role back, and deactivating, activating and deleting an application user', async () => {
  const { dv, requests } = recorded();
  await dv.removeRole('user-1', 'role-1');
  await dv.disableUser('user-1');
  await dv.enableUser('user-1');
  await dv.deleteUser('user-1');
  assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), [
    'DELETE /systemusers(user-1)/systemuserroles_association(role-1)/$ref',
    'PATCH /systemusers(user-1)',
    'PATCH /systemusers(user-1)',
    'DELETE /systemusers(user-1)',
  ]);
  assert.deepEqual(requests.map((r) => r.opts.body), [undefined, { isdisabled: true }, { isdisabled: false }, undefined]);
  // A PATCH without If-Match would create a user that's already gone, rather than answer 404.
  assert.deepEqual(requests.map((r) => r.opts.headers['If-Match']), [undefined, '*', '*', undefined]);
  for (const r of requests) assert.equal(r.opts.headers['OData-Version'], '4.0');
});
