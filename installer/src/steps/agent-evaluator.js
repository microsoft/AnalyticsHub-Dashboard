// @ts-check
/**
 * The Agent Evaluator, from AgentEvaluator-for-Copilot-Studio: the Power Platform environments
 * whose Copilot Studio transcripts the parser notebook reads, the app's access to them, and the
 * Agent Evaluator model, which reads the Lakehouse through the ValueLens model's connection. On
 * Azure, azure/agent-evaluator.js reuses the picker and the access step for the jobs' managed identity.
 */
import { orgUrl, TRANSCRIPT_ROLE } from '../clients/dataverse.js';
import { semanticModelDefinition } from '../clients/fabric.js';
import { HttpError } from '../http.js';
import { rlsSettings } from '../transform/access.js';
import { buildAgentEvaluatorModel, loadTemplateModel, PBISM } from '../transform/model.js';
import { c } from '../ui.js';
import { agentEvaluatorOn } from './fabric.js';
import { bindModel, deployModel, modelUrl, waitForSqlEndpoint } from './model.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').AgentEnvironment} AgentEnvironment */

/**
 * Who reads the transcripts: the app on Fabric, or the jobs' managed identity on Azure.
 * @typedef {object} TranscriptReader
 * @property {string} appId  The application (client) ID its application users are made for.
 * @property {string} name  Its name mid-sentence.
 * @property {string} [title]  Its name at the start of a sentence. Defaults to `name`.
 * @property {boolean} [managed]  It's a managed identity, which admins find by its client ID rather than its name.
 * @property {string} [identity]  The managed identity's resource name.
 * @property {{ leaveOut?: string, none?: string, unread?: string, fill?: string }} [notes]  What to say instead of the Fabric texts.
 * @property {(env: AgentEnvironment, grant?: Omit<TranscriptGrant, 'result'>) => void} [record]  Called once it can read an environment, or was given something there.
 * @property {(config: import('../config.js').InstallConfig) => boolean} [reads]  Whether the transcripts are read. Defaults to Fabric's agentEvaluatorOn.
 */

/**
 * What adding a reader to an environment did.
 * @typedef {object} TranscriptGrant
 * @property {'ok' | 'added' | 'disabled' | 'no-role'} result
 * @property {string} [userId]  Its application user.
 * @property {boolean} [createdUser]  The application user was created now.
 * @property {string} [roleId]  The Bot Transcript Viewer role, when it was assigned now.
 */

/** The app, which the transcript notebook signs in as. @param {Ctx} ctx @returns {TranscriptReader} */
const appReader = (ctx) => ({ appId: /** @type {string} */ (ctx.config.app.appId), name: ctx.config.app.displayName ?? 'the app' });

/**
 * The Agent Evaluator model is deployed: the module is on with environments chosen, the ValueLens
 * model (whose connection it shares) is on, and this checkout has the template.
 * @param {Ctx} ctx
 */
export const agentEvaluatorModelWanted = (ctx) =>
  !!(ctx.config.modules.agentEvaluator && ctx.config.agentEvaluator.environments.length && ctx.config.semanticModel.enabled && ctx.sources.agentEvaluatorModelFile);

/** @param {string} v */
function validateUrls(v) {
  for (const part of splitUrls(v)) {
    try {
      if (new URL(part).protocol !== 'https:') return `${part} isn't an https URL.`;
    } catch {
      return `${part} isn't a URL. Use the environment URL, e.g. https://contoso.crm.dynamics.com.`;
    }
  }
  return true;
}

/** @param {string} v */
const splitUrls = (v) => v.split(/[\s,;]+/).filter(Boolean);

/** @param {string} url */
const host = (url) => new URL(url).host;

/** Environments probed for agents at once, and how long each probe may take. */
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 8000;

/** Discovery doesn't flag the default environment; its name ends "(default)". */
const isDefault = (/** @type {import('../clients/dataverse.js').DataverseInstance} */ i) => /\(default\)\s*$/i.test(i.FriendlyName ?? '');

/**
 * Which environments hold Copilot Studio agents. An environment that can't be read in time, or
 * at all, is left out of the answer rather than guessed.
 * @param {Ctx} ctx
 * @param {string[]} urls
 * @returns {Promise<Map<string, boolean>>}
 */
export async function environmentsWithAgents(ctx, urls) {
  /** @type {Map<string, boolean>} */
  const found = new Map();
  const queue = [...urls];
  const probe = async (/** @type {string} */ url) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, PROBE_TIMEOUT_MS, undefined);
      timer.unref?.();
    });
    try {
      const dv = ctx.api.dataverse(url);
      if (typeof dv?.hasAgents !== 'function') return;
      const has = await Promise.race([dv.hasAgents(), timeout]);
      if (typeof has === 'boolean') found.set(url, has);
    } catch {
      // No access to the bot table yet: the person ticks the environment themselves.
    } finally {
      clearTimeout(timer);
    }
  };
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) await probe(url);
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker));
  return found;
}

/**
 * Asks which environments' transcripts to read.
 * @param {Ctx} ctx
 * @param {{ azure?: boolean }} [opts]  azure: for the Azure jobs, which read the transcripts as their managed identity.
 */
export async function planAgentEvaluator(ctx, opts = {}) {
  const { ui, config, api, sources } = ctx;
  const ae = config.agentEvaluator;
  const none = opts.azure ? 'No environments chosen, so the jobs don\'t read transcripts.' : 'No environments chosen, so the transcript notebook isn\'t deployed.';
  /** The access an environment had, kept while it stays chosen. @param {AgentEnvironment | undefined} prev */
  const kept = (prev) => (prev?.access ? { access: true, ...(opts.azure && prev.accessAppId ? { accessAppId: prev.accessAppId } : {}) } : {});
  ui.heading('Copilot Studio transcripts');
  // The Azure install says so itself if this checkout has no Agent Evaluator report.
  if (!opts.azure && !config.semanticModel.enabled) {
    ui.note('The transcripts model shares the main semantic model\'s connection, so it is only deployed with it.');
    ui.note('The notebook still loads the transcripts; publish the transcripts report ("Agent Evaluator.pbit") yourself.');
  } else if (!opts.azure && !sources.agentEvaluatorModelFile) {
    ui.note('This checkout has no transcripts report ("Agent Evaluator.pbit"), so only the notebook is deployed.');
  }

  /** @type {import('../clients/dataverse.js').DataverseInstance[] | undefined} */
  let found;
  try {
    found = (await api.discovery.instances()).filter((i) => i.Url && (i.State ?? 0) === 0);
  } catch (err) {
    ui.warn(`Couldn't list your Power Platform environments (${/** @type {Error} */ (err).message}).`);
  }

  /** @type {string[]} */
  let urls;
  if (!found?.length) {
    if (found) ui.note('You aren\'t a member of any Power Platform environment.');
    const answer = await ui.input('Environment URLs to read, separated by commas. Leave blank to skip.', {
      default: ae.environments.map((e) => e.url).join(', '),
      validate: validateUrls,
    });
    urls = splitUrls(answer).map(orgUrl);
  } else {
    const before = new Set(ae.environments.map((e) => e.url));
    const listed = found
      .map((i) => ({ i, url: orgUrl(i.Url) }))
      .sort((a, b) => (a.i.FriendlyName ?? a.url).localeCompare(b.i.FriendlyName ?? b.url));
    const listedUrls = new Set(listed.map((l) => l.url));
    const missing = ae.environments.filter((e) => !listedUrls.has(e.url));
    /** @type {Set<string>} */
    let ticked = before;
    if (!before.size) {
      // First time: tick the environments that hold agents, or else the default one, and say which.
      const agents = await environmentsWithAgents(ctx, listed.map((l) => l.url));
      const withAgents = listed.filter((l) => agents.get(l.url)).map((l) => l.url);
      const fallback = listed.filter((l) => isDefault(l.i)).map((l) => l.url);
      ticked = new Set(withAgents.length ? withAgents : fallback);
      if (withAgents.length) ui.note(`Ticked the ${withAgents.length === 1 ? 'environment that has' : `${withAgents.length} environments that have`} Copilot Studio agents.`);
      else if (listed.length > 1) {
        ui.note(
          fallback.length
            ? 'Couldn\'t tell which environments have Copilot Studio agents, so only the default environment is ticked. Tick every environment that holds your agents.'
            : 'Couldn\'t tell which environments have Copilot Studio agents. Tick every environment that holds your agents.',
        );
      }
    }
    ui.note('Only environments you\'re a member of are listed. To add one later, run the installer again and choose Repair or change.');
    urls = await ui.checkbox('Read the environments that hold your Copilot Studio agents', [
      ...listed.map(({ i, url }) => ({
        name: `${i.FriendlyName ?? i.UniqueName ?? host(url)} (${host(url)})`,
        value: url,
        checked: ticked.has(url),
        ...(i.IsUserSysAdmin === false ? { description: opts.azure ? 'You aren\'t a System Administrator here, so an admin adds the jobs\' managed identity.' : 'You aren\'t a System Administrator here, so an admin adds the app.' } : {}),
      })),
      ...missing.map((e) => ({ name: `${e.name ?? host(e.url)} (${host(e.url)}, not in your list)`, value: e.url, checked: true })),
    ]);
    const meta = new Map(listed.map(({ i, url }) => [url, i]));
    ae.environments = urls.map((url) => {
      const i = meta.get(url);
      const prev = ae.environments.find((e) => e.url === url);
      return { url, id: i?.EnvironmentId ?? prev?.id, name: i?.FriendlyName ?? prev?.name, ...kept(prev) };
    });
    if (!urls.length) ui.warn(none);
    return;
  }
  ae.environments = [...new Set(urls)].map((url) => {
    const prev = ae.environments.find((e) => e.url === url);
    return { url, ...(prev?.id ? { id: prev.id } : {}), ...(prev?.name ? { name: prev.name } : {}), ...kept(prev) };
  });
  if (!urls.length) ui.warn(none);
}

/**
 * Adds the app as an application user with the Bot Transcript Viewer role.
 * @param {import('../clients/dataverse.js').DataverseApi} dv
 * @param {string} appId
 * @returns {Promise<'ok' | 'added' | 'disabled' | 'no-role'>}
 */
export async function grantTranscriptAccess(dv, appId) {
  return (await addTranscriptReader(dv, appId)).result;
}

/**
 * Adds an application user for `appId` with the Bot Transcript Viewer role, and says what it
 * created, so that only that is removed later. When a step after creating the user fails, the
 * error carries the grant so far as `grant`.
 * @param {import('../clients/dataverse.js').DataverseApi} dv
 * @param {string} appId
 * @returns {Promise<TranscriptGrant>}
 */
export async function addTranscriptReader(dv, appId) {
  let user = await dv.findAppUser(appId);
  /** @type {{ createdUser?: boolean }} */
  const made = {};
  if (!user) {
    const bu = await dv.rootBusinessUnit();
    if (!bu) throw new Error('Dataverse returned no root business unit.');
    user = { systemuserid: await dv.createAppUser(appId, bu), _businessunitid_value: bu };
    made.createdUser = true;
  }
  const userId = user.systemuserid;
  try {
    if (user.isdisabled) return { result: 'disabled', userId, ...made };
    const bu = user._businessunitid_value ?? (await dv.rootBusinessUnit());
    const role = bu ? await dv.findRole(TRANSCRIPT_ROLE, bu) : undefined;
    if (!role) return { result: 'no-role', userId, ...made };
    const has = (await dv.userRoleIds(userId)).some((r) => r.toLowerCase() === role.toLowerCase());
    if (!has) await dv.assignRole(userId, role);
    return { result: made.createdUser || !has ? 'added' : 'ok', userId, ...made, ...(has ? {} : { roleId: role }) };
  } catch (err) {
    if (made.createdUser && err instanceof Error) Object.assign(err, { grant: { userId, ...made } });
    throw err;
  }
}

/**
 * Gives the app read access to transcripts in each chosen environment, or explains how an admin does.
 * @param {Ctx} ctx
 * @param {TranscriptReader} [reader]  Who reads them. Defaults to the app.
 * @returns {Promise<boolean>}  Whether the transcripts are read: on Fabric, whether the transcript notebook can run.
 */
export async function ensureTranscriptAccess(ctx, reader = appReader(ctx)) {
  const { ui, config, api } = ctx;
  const envs = config.agentEvaluator.environments;
  const app = reader.name;
  const App = reader.title ?? reader.name;
  if (!envs.length) {
    ui.note(reader.notes?.none ?? 'No environments chosen, so the transcript notebook isn\'t deployed.');
    return false;
  }
  for (const env of envs) {
    const where = env.name ?? host(env.url);
    if (env.access) {
      ui.ok(`${App} can read transcripts in ${where}`);
      reader.record?.(env);
      continue;
    }
    /** @type {TranscriptGrant} */
    let grant;
    try {
      grant = await addTranscriptReader(api.dataverse(env.url), reader.appId);
    } catch (err) {
      const made = /** @type {{ grant?: TranscriptGrant }} */ (err)?.grant;
      if (made && reader.record) {
        reader.record(env, made);
        ctx.save();
      }
      if (!(err instanceof HttpError)) throw err;
      if (err.status === 401 || err.status === 403) {
        ui.warn(`You can't add ${app} to ${where}, so its transcripts are skipped until someone does.`);
        manualSteps(ctx, env, reader);
        if (!ui.yes) {
          const done = await ui.select('Then:', [
            { name: 'Leave it out for now', value: false, description: reader.notes?.leaveOut ?? 'The notebook picks it up on the first run after the app is added.' },
            { name: 'It already has access', value: true },
          ], false);
          if (done) {
            env.access = true;
            reader.record?.(env);
            ctx.save();
          }
        }
      } else {
        ui.warn(`Couldn't set up ${app} in ${where} (${err.message}). Its transcripts are skipped for now.`);
      }
      continue;
    }
    if (grant.result === 'disabled' || grant.result === 'no-role') {
      if (reader.record) {
        reader.record(env, grant);
        ctx.save();
      }
      if (grant.result === 'disabled') {
        ui.warn(`${App}'s application user in ${where} is disabled, so its transcripts are skipped.`);
        ui.info('Enable it in the Power Platform admin center: the environment > Settings > Users + permissions > Application users.');
      } else {
        ui.warn(`${where} has no ${TRANSCRIPT_ROLE} role, so Copilot Studio isn't set up there. Its transcripts are skipped.`);
      }
      continue;
    }
    env.access = true;
    reader.record?.(env, grant);
    ctx.save();
    ui.ok(grant.result === 'added' ? `Gave ${app} the ${TRANSCRIPT_ROLE} role in ${where}` : `${App} can read transcripts in ${where}`);
  }
  const ready = reader.reads ? reader.reads(config) : agentEvaluatorOn(config);
  if (!ready) ui.note(reader.notes?.unread ?? 'The app can\'t read any of the environments yet, so the transcript notebook isn\'t deployed. Run the installer again once it can.');
  return ready;
}

/**
 * How a System Administrator adds the reader by hand.
 * @param {Ctx} ctx
 * @param {AgentEnvironment} env
 * @param {TranscriptReader} reader
 */
function manualSteps(ctx, env, reader) {
  const { ui } = ctx;
  ui.info(`A System Administrator of ${env.name ?? host(env.url)} can add it in the Power Platform admin center:`);
  ui.info('  Manage > Environments > the environment > Settings > Users + permissions > Application users >');
  if (reader.managed) {
    // The admin center finds a managed identity by its application (client) ID, not its name.
    ui.info(`  New app user > + Add an app. Search for the managed identity by its client ID, ${reader.appId}${reader.identity ? `, not by its name (${reader.identity})` : ''}.`);
    ui.info(`  Then pick the root business unit and the ${TRANSCRIPT_ROLE} role, and Create.`);
    return;
  }
  ui.info(`  New app user. Pick ${reader.name} (${reader.appId}), the root business unit and the ${TRANSCRIPT_ROLE} role.`);
}

/**
 * Creates the Agent Evaluator model, or updates it when the Lakehouse changed or `force` is set,
 * and connects it through the ValueLens model's connection.
 * @param {Ctx} ctx
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureAgentEvaluatorModel(ctx, opts = {}) {
  const { config, sources } = ctx;
  const m = config.agentEvaluator.model;
  const file = sources.agentEvaluatorModelFile;
  if (!file) throw new Error('This checkout has no "Agent Evaluator.pbit" to build the transcripts model from.');
  const { server, database } = await waitForSqlEndpoint(ctx);
  await deployModel(ctx, m, {
    signature: `${server.toLowerCase()};${database}`,
    definition: () => semanticModelDefinition(buildAgentEvaluatorModel(loadTemplateModel(file), { server, database, access: rlsSettings(ctx.config) }), PBISM),
    force: opts.force,
  });
  if (!m.bound && config.semanticModel.connectionId) await bindModel(ctx, m);
}

/**
 * Which environments are read, and which are waiting for an admin.
 * @param {Ctx} ctx
 * @param {TranscriptReader} [reader]  Who reads them. Defaults to the app.
 */
export function agentEvaluatorSummary(ctx, reader = appReader(ctx)) {
  const { ui, config } = ctx;
  const ae = config.agentEvaluator;
  const ws = /** @type {string} */ (config.fabric.workspaceId);
  ui.heading('Copilot Studio transcripts');
  if (!ae.environments.length) {
    ui.info(`Environments: ${c.dim('none chosen')}`);
    return;
  }
  const who = reader.managed ? `${reader.name} (client ID ${reader.appId})` : reader.name;
  for (const env of ae.environments) {
    const where = `${env.name ?? host(env.url)} ${c.dim(`(${host(env.url)})`)}`;
    ui.info(`  ${env.access ? c.green('✓') : c.yellow('!')} ${where}${env.access ? '' : c.dim(`  waiting for ${who} to be added with ${TRANSCRIPT_ROLE}`)}`);
  }
  // The Azure summary lists its models itself.
  if (ae.model.id && config.target !== 'azure') ui.info(`Model:      ${ae.model.name}  ${c.dim(modelUrl(ws, ae.model.id))}`);
  if (reader.reads ? reader.reads(config) : agentEvaluatorOn(config)) ui.note(reader.notes?.fill ?? 'The agent pages fill after the pipeline\'s first run reads the transcripts.');
}
