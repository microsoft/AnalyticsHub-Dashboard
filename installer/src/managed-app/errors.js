// @ts-check
/**
 * Turns what the managed apps CLI says into who fixes it and how, in a few plain words. The by-hand
 * script and the installer show the same words. The CLI prints no error codes, so this matches its
 * messages and exit codes. Anything it doesn't recognise falls through to "run it again".
 */

/** The managed apps CLI's app registration, which Conditional Access may need to allow. */
export const CLI_APP_ID = '9cee029c-6210-4654-90bb-17e6e9d36617';

export const LINKS = {
  cliSetting: 'https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#control-whether-apps-can-be-created-using-the-cli',
  connectorPolicy: 'https://learn.microsoft.com/microsoft-365/admin/manage/apps/governance#customize-the-default-settings',
  executeQueries: 'https://learn.microsoft.com/fabric/admin/service-admin-portal-integration#semantic-model-execute-queries-rest-api',
  licensing: 'https://learn.microsoft.com/microsoft-365/admin/manage/apps/licensing-faq#what-do-administrators-need-to-set-up-so-users-can-run-apps-with-copilot-credits',
  share: 'https://learn.microsoft.com/microsoft-365/managed-apps/developer/share-app',
  node: 'https://nodejs.org/',
  issues: 'https://github.com/microsoft/AnalyticsHub-Dashboard/issues',
};

/**
 * @typedef {object} Problem
 * @property {string} who  "you", or the admin who fixes it.
 * @property {string} what  What to do.
 * @property {string} [link]
 * @property {string} [message]  What the CLI said.
 * @property {string} [details]  The end of a failed build's output, or the server's words.
 */

/** The tenant-wide steps only an admin can take. Setup checks what it can, and never changes them. */
export const ADMIN_STEPS = /** @type {const} */ ({
  queryAction: {
    who: 'Power Platform admin',
    what: 'Allow the Power BI connector\'s "Run a query" action. It\'s blocked by default. Microsoft 365 admin center > Apps > Settings > Environment groups > your group > Connectors and MCP servers.',
    link: LINKS.connectorPolicy,
  },
  createApps: {
    who: 'Power Platform admin',
    what: 'Turn on "Allow app creation with the Copilot Managed Runtime CLI" for the environment, and check you can create apps in it. Power Platform admin center > Copilot > Settings > Managed apps.',
    link: LINKS.cliSetting,
  },
  externalArtifacts: {
    who: 'Power Platform admin',
    what: 'Turn on "External artifacts in managed apps" for the environment, in the same place. If its environment group has a published rule, change it on the group\'s Rules.',
    link: LINKS.cliSetting,
  },
  executeQueries: {
    who: 'Fabric admin',
    what: 'Turn on "Semantic Model Execute Queries REST API". Admin portal > Tenant settings.',
    link: LINKS.executeQueries,
  },
  licences: {
    who: 'Microsoft 365 admin',
    what: 'Give each viewer Power Apps Premium or Copilot Credits. For credits, turn on usage-based billing and add viewers to a spending policy for managed apps.',
    link: LINKS.licensing,
  },
});

/**
 * @typedef {object} Failure
 * @property {number | null} [exitCode]
 * @property {string} [error]
 * @property {any} [errorData]
 * @property {boolean} [timedOut]
 */

/**
 * Who fixes a failed step, and how.
 * @param {string} step  Which step failed, such as 'init', 'deploy' or 'share'.
 * @param {Failure} result
 * @returns {Problem}
 */
export function explain(step, result) {
  const message = (result.error ?? '').trim();
  const details = detailsOf(result.errorData);
  const problem = (/** @type {Omit<Problem, 'message' | 'details'>} */ fix) => ({
    ...fix,
    ...(message ? { message } : {}),
    ...(details ? { details } : {}),
  });

  if (/AADSTS53003/.test(message)) {
    return problem({
      who: 'Entra admin',
      what: `Conditional Access blocked the sign-in. Allow the managed apps CLI (app ID ${CLI_APP_ID}) in the policy, or sign in from a device it allows.`,
    });
  }
  if (result.timedOut) return problem({ who: 'you', what: 'It took too long, so it was stopped. Run it again. It picks up where it stopped.' });
  if (result.exitCode === 3 || /sign-in session has expired|not signed in|ms auth login/i.test(message)) {
    return problem({ who: 'you', what: 'Your sign-in didn\'t work or has expired. Run it again, and sign in when it asks.' });
  }
  if (/permission to create an app|grant you the required permission/i.test(message)) return problem(ADMIN_STEPS.createApps);
  if (/ms\.config\.json already exists/i.test(message)) {
    return problem({ who: 'you', what: 'This folder already has an app. Run it again to update that app, or add --new to make another.' });
  }
  if (/already exists/i.test(message)) {
    return problem({ who: 'you', what: 'An app with that name already exists. Run it again with --display-name and another name.' });
  }
  if (/environment .*(was )?not found/i.test(message)) {
    return problem({ who: 'you', what: 'That environment wasn\'t found. Check --environment-id, or leave it out to use your own developer environment.' });
  }
  if (/external artifact|AllowExternalArtifactDeployment/i.test(message)) return problem(ADMIN_STEPS.externalArtifacts);
  if (/blocked by your organi[sz]ation's connector policy/i.test(message)) {
    return problem({
      who: 'Power Platform admin',
      what: 'Allow the Power BI connector, and its "Run a query" action, in the environment group\'s connector policy.',
      link: LINKS.connectorPolicy,
    });
  }
  if (/sharing limit .*reached/i.test(message)) {
    return problem({ who: 'you', what: 'Share with a group instead of people one by one: run it again with --share and the group\'s object ID.', link: LINKS.share });
  }
  if (/blocked by an environment or tenant policy/i.test(message)) {
    return problem({
      who: 'Power Platform admin',
      what: 'A policy blocks sharing apps in this environment. Allow it, or deploy to another environment with --environment-id.',
      link: LINKS.share,
    });
  }
  if (/sharing request was rejected/i.test(message)) {
    return problem({ who: 'you', what: 'Check each person and group is in your organisation, then run it again with --share.', link: LINKS.share });
  }
  if (/Graph 403|look up accounts by email/i.test(message)) {
    return problem({ who: 'you', what: 'Your account can\'t look people up by email. Use their object IDs instead, with --share.', link: LINKS.share });
  }
  if (result.exitCode === 5 || /could not reach|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(message)) {
    return problem({ who: 'you', what: 'It couldn\'t reach Microsoft. Check your connection or proxy, then run it again.' });
  }
  if (/temporarily unavailable|too many requests|\b429\b|\b503\b/i.test(message)) {
    return problem({ who: 'you', what: 'The service is busy. Wait a few minutes, then run it again.' });
  }
  if (/exceeds the [\d.]+ ?MB limit/i.test(message)) {
    return problem({ who: 'you', what: 'The build is too big to upload. Delete the dist folder in app, then run it again.' });
  }
  if (step === 'deploy' && /command exited with code/i.test(message)) {
    return problem({ who: 'you', what: 'The build failed. Run npm run build:managed in app to see why.' });
  }
  return problem({ who: 'you', what: 'Run it again. If it fails the same way, open an issue with the message above.', link: LINKS.issues });
}

/**
 * The parts of the CLI's errorData worth showing: the server's words, and the end of a build's output.
 * @param {any} errorData
 */
function detailsOf(errorData) {
  if (!errorData || typeof errorData !== 'object') return '';
  return ['serverMessage', 'stderrTail', 'stdoutTail']
    .map((key) => (typeof errorData[key] === 'string' ? errorData[key].trim() : ''))
    .filter(Boolean)
    .join('\n');
}
