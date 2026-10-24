// @ts-check
/**
 * Commands an admin pastes into Azure Cloud Shell (Bash) to give Analytics Hub's app or managed identity a role.
 * They name the principal by its object ID, never its application (client) ID, and hold no secrets. This module
 * imports nothing from steps/, so any step can use it without a load-order cycle.
 */
import { GRAPH_APP_ID } from './catalog.js';

/**
 * An Azure role for a service principal or managed identity. --assignee-object-id skips the Microsoft Graph lookup,
 * which an admin may not be allowed to make, and the principal type avoids errors while a new one propagates.
 * @param {string} objectId  The enterprise application's object ID, or the managed identity's principal ID.
 * @param {string} role
 * @param {string} scope
 */
export const roleAssignmentCommand = (objectId, role, scope) =>
  `az role assignment create --assignee-object-id ${objectId} --assignee-principal-type ServicePrincipal --role "${role}" --scope ${scope}`;

/**
 * A service principal's object ID for a command or, when only its application (client) ID is known, a lookup of it
 * in the command.
 * @param {string | undefined} objectId
 * @param {string | undefined} appId
 */
export const objectIdOrLookup = (objectId, appId) => objectId || (appId ? `$(az ad sp show --id ${appId} --query id -o tsv)` : '<object ID>');

/**
 * The Microsoft Graph roles an Azure install couldn't give the jobs' managed identity, each once: a role can be
 * listed more than once.
 * @param {{ pending?: string[], assigned?: string[] } | undefined} graphRoles  The install record's.
 */
export const pendingGraphRoles = (graphRoles) => {
  const assigned = new Set(graphRoles?.assigned ?? []);
  return [...new Set(graphRoles?.pending ?? [])].filter((r) => !assigned.has(r));
};

/**
 * One line that gives a managed identity Microsoft Graph application permissions (app roles), each once. Only a
 * Privileged Role Administrator or Global Administrator can give Microsoft Graph app roles. It skips a role the
 * tenant doesn't have yet, and says so. resourceId is Microsoft Graph's service principal object ID in the tenant,
 * not its app ID.
 * @param {string} principalId  The managed identity's principal (object) ID.
 * @param {string[]} roles  Such as AuditLogsQuery.Read.All.
 */
export function graphRolesCommand(principalId, roles) {
  return (
    `MI=${principalId}; GRAPH=$(az ad sp show --id ${GRAPH_APP_ID} --query id -o tsv); ` +
    `for P in ${[...new Set(roles)].join(' ')}; do ` +
    'ROLE=$(az ad sp show --id $GRAPH --query "appRoles[?value==\'$P\'].id | [0]" -o tsv); ' +
    'if [ -n "$ROLE" ]; then az rest -m POST -u https://graph.microsoft.com/v1.0/servicePrincipals/$MI/appRoleAssignments ' +
    '-b "{\\"principalId\\": \\"$MI\\", \\"resourceId\\": \\"$GRAPH\\", \\"appRoleId\\": \\"$ROLE\\"}" -o none; ' +
    'else echo "Skipped $P: not in this tenant yet"; fi; done'
  );
}
