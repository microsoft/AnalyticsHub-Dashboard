// @ts-check
// The commands an admin pastes into Azure Cloud Shell (Bash): they name the principal by its object ID, never its
// client ID, hold no secrets, fit on one line, and Bash runs them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { graphRolesCommand, objectIdOrLookup, pendingGraphRoles, roleAssignmentCommand } from '../src/admin-commands.js';
import { GRAPH_APP_ID } from '../src/catalog.js';

const LOOKUP = '$(az ad sp show --id app-client --query id -o tsv)';

test('roleAssignmentCommand: names the principal by its object ID, as a service principal', () => {
  assert.equal(
    roleAssignmentCommand('sp-obj', 'Cost Management Reader', '/subscriptions/sub-1'),
    'az role assignment create --assignee-object-id sp-obj --assignee-principal-type ServicePrincipal --role "Cost Management Reader" --scope "/subscriptions/sub-1"',
  );
});

test('objectIdOrLookup: the object ID when it is known, else a lookup from the client ID, never the client ID alone', () => {
  assert.equal(objectIdOrLookup('sp-obj', 'app-client'), 'sp-obj');
  assert.equal(objectIdOrLookup(undefined, 'app-client'), LOOKUP);
  assert.equal(objectIdOrLookup('', 'app-client'), LOOKUP);
  assert.equal(objectIdOrLookup(undefined, undefined), '<object ID>');
  const cmd = roleAssignmentCommand(objectIdOrLookup(undefined, 'app-client'), 'Reader', '/subscriptions/sub-1');
  assert.ok(cmd.includes(`--assignee-object-id ${LOOKUP} --assignee-principal-type ServicePrincipal`));
  assert.doesNotMatch(cmd, /--assignee app-client|--assignee-object-id app-client/);
});

test('pendingGraphRoles: each role once, without the ones given since', () => {
  assert.deepEqual(pendingGraphRoles({ pending: ['A', 'B', 'A', 'C', 'B'], assigned: ['C'] }), ['A', 'B']);
  assert.deepEqual(pendingGraphRoles({ pending: ['A'] }), ['A']);
  assert.deepEqual(pendingGraphRoles(undefined), []);
});

test("graphRolesCommand: one line that gives each role once to the managed identity, through Microsoft Graph's service principal", () => {
  const cmd = graphRolesCommand('mi-principal', ['Reports.Read.All', 'User.Read.All', 'Reports.Read.All']);
  assert.ok(!cmd.includes('\n'), 'one line, so a terminal line copies cleanly');
  assert.ok(cmd.startsWith('MI=mi-principal; '));
  assert.ok(cmd.includes(`GRAPH=$(az ad sp show --id ${GRAPH_APP_ID} --query id -o tsv)`));
  assert.ok(cmd.includes('for P in Reports.Read.All User.Read.All; do '), 'each role once');
  assert.ok(cmd.includes(`--query "appRoles[?value=='$P'].id | [0]" -o tsv`));
  assert.ok(cmd.includes('az rest -m POST -u https://graph.microsoft.com/v1.0/servicePrincipals/$MI/appRoleAssignments'));
  // resourceId is Microsoft Graph's service principal object ID in the tenant, not its app ID.
  assert.ok(cmd.includes('\\"resourceId\\": \\"$GRAPH\\"'));
  assert.ok(cmd.endsWith('else echo "Skipped $P: not in this tenant yet"; fi; done'), "a role the tenant doesn't have is skipped, and said");
  assert.doesNotMatch(cmd, /secret|password|token|key/i);
});

/** Runs a script in Bash, or returns undefined when there's no Bash. @param {string} script */
function bash(script) {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.error || probe.stdout !== 'ok\n') return undefined;
  return spawnSync('bash', ['-s'], { input: `${script}\n`, encoding: 'utf8' });
}

// A stand-in for az. Microsoft Graph's service principal is graph-sp-obj, the app's is sp-obj, and every role has an
// ID except Missing.Read.All, as in a tenant without it. It prints the calls that make a change: a role assignment's
// arguments each in brackets, so a test can see where Bash split them.
const AZ = `az() {
  case "$1" in
    rest) printf 'POST %s %s\\n' "$5" "$7"; return;;
    role) printf 'ROLE'; printf ' [%s]' "$@"; printf '\\n'; return;;
  esac
  if [ "$7" = id ]; then if [ "$5" = app-client ]; then echo sp-obj; else echo graph-sp-obj; fi; return; fi
  local q="'"
  local v="\${7#*$q}"
  v="\${v%%$q*}"
  [ "$v" = Missing.Read.All ] && return
  echo "role-$v"
}`;

test('the commands: Bash accepts them', (t) => {
  const cmds = [
    graphRolesCommand('mi-principal', ['Reports.Read.All', 'Missing.Read.All']),
    roleAssignmentCommand(objectIdOrLookup(undefined, 'app-client'), 'Reader', '/subscriptions/sub-1'),
  ];
  for (const cmd of cmds) {
    const r = bash(`set -n\n${cmd}`);
    if (!r) return t.skip('bash is not on the PATH');
    assert.equal(r.status, 0, r.stderr);
  }
});

test("graphRolesCommand, run: posts each role Microsoft Graph has, as JSON, and skips the one it doesn't", (t) => {
  const r = bash(`${AZ}\n${graphRolesCommand('mi-principal', ['Reports.Read.All', 'Missing.Read.All', 'User.Read.All', 'Reports.Read.All'])}`);
  if (!r) return t.skip('bash is not on the PATH');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  const url = 'https://graph.microsoft.com/v1.0/servicePrincipals/mi-principal/appRoleAssignments';
  const posts = lines.filter((l) => l.startsWith('POST ')).map((l) => {
    const [, to, body] = /^POST (\S+) (.*)$/.exec(l) ?? [];
    return { to, body: JSON.parse(body) };
  });
  assert.deepEqual(posts, [
    { to: url, body: { principalId: 'mi-principal', resourceId: 'graph-sp-obj', appRoleId: 'role-Reports.Read.All' } },
    { to: url, body: { principalId: 'mi-principal', resourceId: 'graph-sp-obj', appRoleId: 'role-User.Read.All' } },
  ]);
  assert.deepEqual(lines.filter((l) => !l.startsWith('POST ')), ['Skipped Missing.Read.All: not in this tenant yet']);
});

/** What the stand-in prints for a role assignment. @param {string[]} args */
const roleCall = (args) => `ROLE ${args.map((a) => `[${a}]`).join(' ')}\n`;

test('roleAssignmentCommand with a lookup, run: the assignee is the object ID the lookup finds', (t) => {
  const r = bash(`${AZ}\n${roleAssignmentCommand(objectIdOrLookup(undefined, 'app-client'), 'Reader', '/subscriptions/sub-1')}`);
  if (!r) return t.skip('bash is not on the PATH');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, roleCall(['role', 'assignment', 'create', '--assignee-object-id', 'sp-obj', '--assignee-principal-type', 'ServicePrincipal', '--role', 'Reader', '--scope', '/subscriptions/sub-1']));
});

test('roleAssignmentCommand, run: a scope with parentheses, which management group and resource group names allow, arrives as one argument', (t) => {
  for (const scope of ['/providers/Microsoft.Management/managementGroups/mg(prod)', '/subscriptions/sub-1/resourceGroups/rg(prod)']) {
    const r = bash(`${AZ}\n${roleAssignmentCommand('sp-obj', 'Cost Management Reader', scope)}`);
    if (!r) return t.skip('bash is not on the PATH');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, roleCall(['role', 'assignment', 'create', '--assignee-object-id', 'sp-obj', '--assignee-principal-type', 'ServicePrincipal', '--role', 'Cost Management Reader', '--scope', scope]));
    // Unquoted, Bash stops at the parenthesis, and the command can't be pasted.
    const unquoted = bash(`set -n\naz role assignment create --assignee-object-id sp-obj --role Reader --scope ${scope}`);
    assert.notEqual(unquoted?.status, 0, scope);
    assert.match(unquoted?.stderr ?? '', /syntax error near unexpected token `\('/, scope);
  }
});
