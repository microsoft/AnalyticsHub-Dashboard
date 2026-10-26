// @ts-check
/**
 * What's left for you once the installer finishes, as cards for the Done page and the terminal summary: the steps you
 * do yourself, in the order to do them, so new steps only need adding here. What's left for other admins is a request
 * each, built by doneRequests (handoff.js) and shown after the cards.
 */
import { COWORK_DATAFLOW_ACTIVITY } from '../transform/pipeline.js';
import { commandLine } from '../launch.js';
import { appItemUrl, groupNames, shareAppPending, shareAppSteps, sharedRetiredGroups, VIEWER_GROUP_NAME, myGroupsUrl } from './access.js';
import { COWORK_DATAFLOW_NAME, coworkSignInSteps } from './consumption.js';
import { coworkDataflowOn, modelDeployed } from './fabric.js';
import { connectionSteps, FLOW_NAMES, flowsWanted, ownerLeft, ppApiFlows, ppApiSigner, whoSignsIn } from './flows.js';

/**
 * @typedef {object} NextStep
 * @property {string} id  Stable, e.g. "share-app".
 * @property {string} title
 * @property {string} why  Why it matters, in a sentence or two.
 * @property {string} who  Who does it, e.g. "You" or "A Microsoft 365 admin".
 * @property {string} [link]
 * @property {string} [linkText]
 * @property {string[]} [steps]  One whole step each, to show numbered.
 * @property {string} [message]  For a hand-off: a message to copy and send to whoever does it.
 * @property {string} [activity]  The pipeline activity that fails until it's done. That failure is expected.
 * @property {boolean} [optional]
 */

export const M365_ADMIN_URL = 'https://admin.microsoft.com/';
const MAKER = 'https://make.powerautomate.com/';

/**
 * A message to someone else: a greeting, the ask, the details, and a sign-off.
 * @param {string[]} body
 * @param {string | undefined} from
 */
export const letter = (body, from) => ['Hi,', '', ...body, '', 'Thanks', ...(from ? [from] : [])].join('\n');

/** @param {string[]} steps */
const numbered = (steps) => steps.map((s, i) => `${i + 1}. ${s}`);

/**
 * Your cards, in the order to do them: deploy the app if it isn't, share it, sign in to the flows and the Cowork
 * Dataflow, then show names in the usage reports when you're the Global Administrator who can. Empty when none of
 * them is left, though requests for other admins may be: doneRequests (handoff.js) builds those.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string, upn?: string }} [user]
 * @param {{ appFailed?: boolean, names?: { unsure?: boolean } }} [opts]  appFailed: this run's app step failed. names: you're a
 *   Global Administrator and the reports may conceal names, so the card is yours rather than a request; unsure: no data check could tell.
 * @returns {NextStep[]}
 */
export function nextSteps(config, user = {}, opts = {}) {
  return [
    deployAppStep(config, opts),
    shareStep(config, user),
    flowsStep(config, user),
    coworkStep(config),
    ...(opts.names ? [namesStep(opts.names)] : []),
  ].filter(/** @returns {s is NextStep} */ (s) => !!s);
}

/**
 * "2 steps left", "1 step left, and 1 optional".
 * @param {NextStep[]} steps
 */
export function stepsLeftTitle(steps) {
  const needed = steps.filter((s) => !s.optional).length;
  const optional = steps.length - needed;
  if (!needed) return `${optional} optional ${optional === 1 ? 'step' : 'steps'}`;
  return `${needed} ${needed === 1 ? 'step' : 'steps'} left${optional ? `, and ${optional} optional` : ''}`;
}

/**
 * The app the user chose, when this run's app step failed or it isn't deployed: the step said to fix the
 * problem and run deploy-app, and that's easy to lose in a run that then loads data for hours.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ appFailed?: boolean }} opts
 * @returns {NextStep | null}
 */
function deployAppStep(config, opts) {
  const fa = config.fabricApp;
  const sm = config.semanticModel;
  if (config.target === 'azure' || !fa?.enabled || !sm?.enabled || !sm.id) return null;
  if (fa.itemId && !opts.appFailed) return null;
  // deploy-app needs the model connected to the Lakehouse; the installer connects it, and asks to share the app.
  const connected = modelDeployed(config);
  // With an app from before, the share card covers sharing.
  const share = connected && !fa.itemId && !!config.access?.groupId && config.access.appShared !== true;
  const group = config.access?.groupName ?? VIEWER_GROUP_NAME;
  return {
    id: 'deploy-app',
    title: fa.itemId ? 'Deploy the Analytics Hub app again' : 'Deploy the Analytics Hub app',
    why: fa.itemId
      ? 'The app step above failed. Until the app is deployed again, viewers get it as it was last deployed.'
      : "There's no app for viewers to open until it's deployed. The data and the models don't need it.",
    who: 'You',
    steps: [
      'Fix the problem the app step shows.',
      connected
        ? `Run "${commandLine('deploy-app')}", or choose Redeploy the app on the installer's home page.`
        : `Run the installer again. It connects ${sm.name ?? 'the semantic model'} to the Lakehouse, then deploys the app.`,
      ...(share ? [`Share it with "${group}": run "${commandLine('access')}" and choose Share the app with the group.`] : []),
    ],
  };
}

/**
 * Share the app with the viewer group, and take it off a group that was the viewer group. Fabric has
 * no API for either, so one "I've shared it" covers both.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ tenantId?: string }} user
 * @returns {NextStep | null}
 */
function shareStep(config, user) {
  if (!shareAppPending(config)) return null;
  const group = config.access?.groupName ?? VIEWER_GROUP_NAME;
  const sharing = config.access?.appShared !== true;
  const old = sharedRetiredGroups(config);
  const names = groupNames(old);
  const [isnt, its, them] = old.length === 1 ? ["isn't", 'its', 'it'] : ["aren't", 'their', 'them'];
  const off = `${names} ${isnt} the viewer group any more, but ${its} members can still open the app.`;
  return {
    id: 'share-app',
    title: sharing ? `Share the app with ${group}` : `Take ${names} off the app`,
    why: sharing
      ? `Once only. Until it's shared, people in the group get "no access" when they open the app. After that, give people access by adding them to the group${config.access?.groupId ? ` (${myGroupsUrl(config.access.groupId)})` : ''}.${old.length ? ` ${off} Take ${them} off the app too.` : ''}`
      : `${off} Fabric has no API to take ${them} off.`,
    who: 'You',
    link: appItemUrl(config, user.tenantId),
    linkText: 'Open the app item in Fabric',
    steps: shareAppSteps(config, user.tenantId),
  };
}

/**
 * The flows the installer made or wrote out, which someone signs in to and turns on.
 * Doubles as the hand-off to a Power Platform admin.
 * @param {import('../config.js').InstallConfig} config
 * @param {{ upn?: string }} user
 * @returns {NextStep | null}
 */
function flowsStep(config, user) {
  const up = config.uploads;
  const kinds = flowsWanted(config).filter((k) => up?.flowIds?.[k] || up?.flowFiles?.[k]);
  if (!kinds.length) return null;
  const env = up.flowEnvironment;
  const link = env?.id ? `${MAKER}environments/${env.id}/flows` : MAKER;
  const where = env?.name ?? env?.url ?? 'the Power Automate environment';
  /** @type {string[]} */
  const steps = [];
  /** @type {string[]} */
  const details = [];
  for (const kind of kinds) {
    const name = FLOW_NAMES[kind];
    const file = up.flowFiles?.[kind];
    const open = file ? `Import ${name} from ${file} into ${where}` : `Open ${name} in ${where}`;
    const signIns = connectionSteps(config, kind);
    steps.push(`${open}, sign in to its connections, save it and turn it on. ${whoSignsIn(config, kind)}`);
    details.push(`${name}${file ? ` (to import: ${file})` : ''}:`, ...numbered([open + '.', ...signIns, 'Save, then turn it on.']).map((s) => `  ${s}`), '');
  }
  const one = kinds.length === 1;
  const them = one ? 'it' : 'them';
  const ppApi = ppApiFlows(config);
  return {
    id: 'flows',
    title: `Sign in to the Power Automate ${one ? 'flow' : 'flows'}`,
    why: `${one ? 'It stays' : 'They stay'} off until ${one ? 'its' : 'their'} connections are signed in, so ${one ? 'its data doesn\'t' : 'their data doesn\'t'} load. ${ownerLeft(one)}`,
    who: kinds.some((k) => ppApi.includes(k)) ? `You, or ${ppApiSigner(config)}` : 'You',
    link,
    linkText: 'Open Power Automate',
    steps,
    message: letter(
      [
        `Could you sign in to the connections of the Analytics Hub ${one ? 'flow' : 'flows'} in Power Automate and turn ${them} on? ${one ? 'It is' : 'They are'} in ${where}: ${link}`,
        '',
        ...details,
        // A flow imported from a file is owned by whoever imports it.
        kinds.some((k) => up.flowFiles?.[k])
          ? 'A flow runs on its owner\'s Power Automate Premium licence, and whoever imports one owns it. Whoever signs in to its connections doesn\'t need Premium. If the owner\'s account or licence is removed, Power Automate slows the flow down, and turns it off after 14 days unless someone takes it over.'
          : `${one ? 'The flow runs' : 'The flows run'} on my Power Automate Premium licence, because I own ${them}, so you don't need Premium to sign in to ${one ? 'its' : 'their'} connections. If my account or licence is removed, Power Automate slows ${them} down, and turns ${them} off after 14 days unless someone takes ${them} over.`,
      ],
      user.upn,
    ),
  };
}

/**
 * The Cowork credits Dataflow, which refreshes only once it has its sign-ins. Until then the
 * pipeline's Dataflow refresh fails, which is expected.
 * @param {import('../config.js').InstallConfig} config
 * @returns {NextStep | null}
 */
function coworkStep(config) {
  if (!coworkDataflowOn(config)) return null;
  const name = config.consumption.dataflowName ?? COWORK_DATAFLOW_NAME;
  const ws = config.fabric.workspaceId;
  return {
    id: 'cowork-dataflow',
    title: `Sign in to the Dataflow ${name}`,
    why: 'Cowork credits load once the Dataflow has its sign-ins. Until then the first load skips it and scheduled runs fail at that step, which is expected: everything else loads.',
    who: 'You',
    ...(ws ? { link: `https://app.fabric.microsoft.com/groups/${ws}`, linkText: 'Open the workspace' } : {}),
    steps: coworkSignInSteps(config),
    activity: COWORK_DATAFLOW_ACTIVITY,
  };
}

/** How a Global Administrator shows user names in the Microsoft 365 usage reports, which conceal them by default. */
export const CONCEALED_NAMES_STEPS = [
  'In the Microsoft 365 admin center, open Settings > Org Settings, the Services tab, then Reports.',
  'Untick "Conceal user, group, and site names in all reports".',
  'Save.',
];

/** Why the reports must show names, and what the setting does, from Microsoft Learn's usage reports overview. */
export const CONCEALED_NAMES_WHY =
  'Analytics Hub matches licences to Copilot activity by user principal name, and Work patterns and the organisation filters need names. ' +
  'By default, all Microsoft 365 reports hide user information such as usernames, display names, groups and sites, to help companies support local privacy laws. ' +
  "A Global Administrator can show it if your organisation's privacy practices allow it. The setting is org-wide: it also applies to the Microsoft 365 usage " +
  'reports in Microsoft Graph and Power BI, and to the usage reports in the Teams admin center. Showing identifiable user information is a logged event in ' +
  'the Microsoft Purview audit log, and the change takes a few minutes.';

/** What happens once names show: nothing to run. */
export const CONCEALED_NAMES_AFTER =
  'Nothing to run: the next load, scheduled or Run now, uses names. Each load reloads the last 28 days of Microsoft 365 activity, so the days loaded without names in that window get them.';

/**
 * Show user names in the usage reports, as your own card: you're a Global Administrator, so it isn't a request.
 * @param {{ unsure?: boolean }} [opts]  unsure: no data check could tell whether the reports conceal names.
 * @returns {NextStep}
 */
export function namesStep(opts = {}) {
  return {
    id: 'concealed-names',
    title: 'Show user names in the Microsoft 365 usage reports',
    why: `${CONCEALED_NAMES_WHY} ${CONCEALED_NAMES_AFTER}${opts.unsure ? " If the reports already show names, there's nothing to do." : ''}`,
    who: 'You',
    link: M365_ADMIN_URL,
    linkText: 'Microsoft 365 admin center',
    steps: CONCEALED_NAMES_STEPS,
  };
}
