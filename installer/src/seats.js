// @ts-check
/**
 * How many people work in the tenant, which sizes the install: how long the pipeline's steps may run, how the
 * audit log is read, and what capacity to recommend. Copilot Chat comes with Microsoft 365, so people without a
 * Copilot seat add Copilot interactions to the audit log too: the count is of people with a licence and an enabled
 * account. Assigned Microsoft 365 Copilot seats stand in when people can't be counted.
 */

/** The service plan in every Microsoft 365 Copilot SKU (Microsoft_365_Copilot, M365_Copilot, the EDU and E7 SKUs, ...). */
export const COPILOT_PLAN = 'M365_COPILOT_APPS';

/** More people than this and a new install starts as a large tenant. */
export const LARGE_TENANT_PEOPLE = 10_000;

/** From this many people, a capacity below F64 is likely to run the loads out of time or memory. */
export const BIG_CAPACITY_PEOPLE = 30_000;

/** Enabled member accounts with at least one licence: the people who can use Microsoft 365, with a Copilot seat or not. */
export const LICENSED_PEOPLE = "accountEnabled eq true and userType eq 'Member' and assignedLicenses/$count ne 0";

/** Enabled member accounts, licensed or not: what's counted when Graph won't count by licence. */
export const ENABLED_PEOPLE = "accountEnabled eq true and userType eq 'Member'";

/**
 * The capacity the Azure path recommends for the Power BI workspace of a large tenant. Provisional: the 20,000-seat
 * Fabric speed tests ran on F64, and the Azure speed test sets the final size, which changes only this line.
 */
export const AZURE_LARGE_TENANT_SKU = 'F64';

/** The max vCores Azure SQL scales to when a large tenant agrees to pay for more than the free offer. */
export const AZURE_LARGE_TENANT_SQL_VCORES = 4;

/**
 * The Copilot SKUs in a `subscribedSkus` list, and how many of their seats are assigned.
 * @param {any[]} skus
 */
export function copilotLicences(skus) {
  const copilot = (skus ?? []).filter((s) => (s.servicePlans ?? []).some((/** @type {any} */ p) => p.servicePlanName === COPILOT_PLAN));
  return {
    names: [...new Set(copilot.map((s) => s.skuPartNumber).filter(Boolean))],
    assigned: copilot.reduce((n, s) => n + (s.consumedUnits ?? 0), 0),
    found: copilot.length > 0,
  };
}

/**
 * Assigned Copilot seats, or undefined when they can't be read.
 * @param {import('./install.js').Apis} api
 * @returns {Promise<number | undefined>}
 */
export async function copilotSeats(api) {
  try {
    return copilotLicences(await api.graph.subscribedSkus()).assigned;
  } catch {
    return undefined;
  }
}

/** @param {number} n */
export const seatCount = (n) => n.toLocaleString('en-US');

/**
 * How many people the tenant has, and what was counted to find out.
 * @typedef {object} Headcount
 * @property {number} count
 * @property {'licensed' | 'enabled' | 'seats'} source  People with a licence and an enabled account; enabled member
 *   accounts, when Graph won't count by licence; or assigned Copilot seats, when it won't count accounts at all.
 */

/**
 * How many people the tenant has. Counts licensed, enabled member accounts, then enabled member accounts, then
 * falls back to the Copilot seats assigned. Undefined when none of them can be read, and the size is then asked
 * with nothing to start from. Reading users needs no admin role: members can by default, and the installer's
 * sign-in already reads them.
 * @param {import('./install.js').Apis} api
 * @param {{ seats?: number }} [read]  The Copilot seats, when they've been read already.
 * @returns {Promise<Headcount | undefined>}
 */
export async function tenantHeadcount(api, read) {
  for (const [source, filter] of /** @type {const} */ ([['licensed', LICENSED_PEOPLE], ['enabled', ENABLED_PEOPLE]])) {
    try {
      const count = await api.graph.countUsers(filter);
      // None counted means the filter found nothing to go on, not an empty tenant.
      if (count > 0) return { count, source };
    } catch {
      // Graph refused the count: try the next.
    }
  }
  const seats = read ? read.seats : await copilotSeats(api);
  return seats ? { count: seats, source: 'seats' } : undefined;
}

/** The size a headcount suggests. @param {Headcount | undefined} h @returns {'standard' | 'large'} */
export const scaleFor = (h) => (h && h.count > LARGE_TENANT_PEOPLE ? 'large' : 'standard');

/** "61,234 people", or "20,000 Copilot seats" when only seats were read. @param {Headcount} h */
export const headcountNoun = (h) =>
  `${seatCount(h.count)} ${h.source === 'seats' ? (h.count === 1 ? 'Copilot seat' : 'Copilot seats') : h.count === 1 ? 'person' : 'people'}`;

/** What was counted, to start a sentence: "61,234 people have a licence and an enabled account". @param {Headcount} h */
export function headcountPhrase(h) {
  const one = h.count === 1;
  if (h.source === 'licensed') return `${headcountNoun(h)} ${one ? 'has' : 'have'} a licence and an enabled account`;
  if (h.source === 'enabled') return `${seatCount(h.count)} member ${one ? 'account is' : 'accounts are'} enabled`;
  return `${headcountNoun(h)} ${one ? 'is' : 'are'} assigned`;
}

/**
 * The tenant line in the plan: "61,234 people (licensed, enabled accounts), 4,000 Copilot seats". Undefined when
 * neither was read.
 * @param {Headcount | undefined} h
 * @param {number} [seats]  Assigned Copilot seats.
 */
export function tenantLine(h, seats) {
  const copilot = seats ? `${seatCount(seats)} Copilot ${seats === 1 ? 'seat' : 'seats'}` : undefined;
  if (!h || h.source === 'seats') {
    const n = seats ?? h?.count;
    return n ? `${seatCount(n)} Copilot ${n === 1 ? 'seat' : 'seats'} (people couldn't be counted)` : undefined;
  }
  const people = `${headcountNoun(h)} (${h.source === 'licensed' ? 'licensed, enabled accounts' : 'enabled accounts'})`;
  return copilot ? `${people}, ${copilot}` : people;
}
