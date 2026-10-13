// @ts-check
/**
 * install.ps1, the PowerShell launcher published next to AnalyticsHubInstaller.exe. It downloads
 * the exe's payload as a zip, checks its SHA-256 and runs the installer with the Node.js inside, for
 * organisations that block downloaded exes. build-exe.js fills in the template in
 * launcher/install.ps1 for each release.
 */

export const ZIP_NAME = 'AnalyticsHubInstaller.zip';
export const SCRIPT_NAME = 'install.ps1';

/**
 * Where a release's zip downloads from.
 * @param {string} repo  owner/name
 * @param {string} version
 */
export const zipUrl = (repo, version) => `https://github.com/${repo}/releases/download/installer-v${version}/${ZIP_NAME}`;

/**
 * The PowerShell command that runs a release's install.ps1, or the latest release's.
 * @param {string} repo
 * @param {string} [version]
 */
export function scriptCommand(repo, version) {
  const path = version ? `download/installer-v${version}` : 'latest/download';
  return `irm https://github.com/${repo}/releases/${path}/${SCRIPT_NAME} | iex`;
}

/**
 * Fills in the launcher template.
 * @param {string} template  launcher/install.ps1
 * @param {{ version: string, sha256: string, id: string, repo: string, sizeMb: number }} v
 */
export function installScript(template, v) {
  if (!/^[0-9a-f]{64}$/i.test(v.sha256)) throw new Error(`"${v.sha256}" isn't a SHA-256.`);
  if (!/^[\w.+-]+$/.test(v.version) || !/^[\w.+-]+$/.test(v.id)) throw new Error('The version and payload ID can only hold letters, digits and . + - _.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(v.repo)) throw new Error(`"${v.repo}" isn't an owner/name.`);
  /** @type {Record<string, string>} */
  const values = {
    VERSION: v.version,
    SHA256: v.sha256.toLowerCase(),
    PAYLOAD_ID: v.id,
    ZIP_URL: zipUrl(v.repo, v.version),
    ZIP_NAME,
    SIZE_MB: String(Math.max(1, Math.round(v.sizeMb))),
    REPO: v.repo,
  };
  const text = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
    if (!(k in values)) throw new Error(`install.ps1 has an unknown placeholder ${m}.`);
    return values[k];
  });
  // Windows PowerShell 5.1 reads a file without a BOM as the system code page, and iex gets whatever irm decoded.
  const odd = [...text].find((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && !'\r\n\t'.includes(ch)));
  if (odd) throw new Error(`install.ps1 must be plain ASCII; it holds U+${odd.charCodeAt(0).toString(16).padStart(4, '0')}.`);
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * The zip SHA-256 a generated install.ps1 checks for, or undefined.
 * @param {string} script
 */
export function scriptSha256(script) {
  const m = /^\s*\$Sha256 = '([0-9a-f]{64})'\s*$/m.exec(script);
  return m ? m[1] : undefined;
}
