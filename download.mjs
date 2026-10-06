const channels = new Set(['alpha', 'beta', 'production']);
const releaseRoot = 'https://github.com/Blendable-dev/appsweet-releases/releases/download/';
const origin = 'https://releases.appsweet.app';
const buildVersion = /^\d+\.\d+\.\d+-build\.[1-9]\d*$/;

const artifacts = {
  'dokploy-bootstrap': { product: 'Dokploy launcher', title: 'Your Dokploy launcher' },
  desktop: { product: 'desktop app', title: 'Your AppSweet desktop app' },
};

/** A channel that has nothing published for this artifact yet: not a failure, so no retry. */
export class NotPublishedError extends Error {
  constructor(channel, artifact) {
    super(`No ${channel} ${artifacts[artifact].product} is published yet.`);
    this.name = 'NotPublishedError';
  }
}

function buildNumbers(version) {
  const [core, build] = version.split('-build.');
  return [...core.split('.'), build].map(Number);
}

function isOlder(left, right) {
  const a = buildNumbers(left);
  const b = buildNumbers(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

/**
 * The newest version of a desktop channel catalog, checked the way the release
 * tooling's validateCatalog checks it (shape, channel, strictly increasing
 * history, fixed candidate URLs). The browser cannot verify the signature, so
 * the version only feeds the fixed public installer URL pattern.
 */
export function latestDesktopVersion(catalog, channel) {
  if (catalog?.schemaVersion !== 1 || catalog.channel !== channel) return null;
  const entries = catalog.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 10000) return null;
  let previous = null;
  for (const entry of entries) {
    const version = entry?.version;
    if (typeof version !== 'string' || !buildVersion.test(version)) return null;
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) return null;
    if (entry.url !== `${origin}/desktop/builds/${version}/candidate.json`) return null;
    if (previous !== null && !isOlder(previous, version)) return null;
    previous = version;
  }
  return previous;
}

function launcherVersion(descriptor, channel) {
  const version = descriptor?.version;
  if (
    descriptor?.schemaVersion !== 2 || descriptor.channel !== channel ||
    typeof version !== 'string' || !buildVersion.test(version) ||
    descriptor.tag !== `backend-v${version}`
  ) return null;
  return version;
}

async function fetchMetadata(path, channel, artifact, fetcher) {
  const response = await fetcher(path, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (response.status === 404) throw new NotPublishedError(channel, artifact);
  if (!response.ok) throw new Error(`The ${channel} release is unavailable. Please try again shortly.`);
  return response.json();
}

export async function resolveDownload(search, fetcher = fetch) {
  const params = new URLSearchParams(search);
  const channel = params.get('channel');
  const artifact = params.get('artifact');
  if (!channels.has(channel) || !Object.hasOwn(artifacts, artifact)) {
    throw new Error('Choose an AppSweet download from the installation guide or the downloads page.');
  }
  const unreadable = () => new Error('The release information could not be read. Please try again shortly.');

  if (artifact === 'desktop') {
    const catalog = await fetchMetadata(`/desktop/channels/${channel}/catalog.json`, channel, artifact, fetcher);
    const version = latestDesktopVersion(catalog, channel);
    if (!version) throw unreadable();
    const filename = `AppSweet-${channel}-aarch64.dmg`;
    return { channel, artifact, version, filename, url: `${releaseRoot}desktop-build-v${version}/${filename}` };
  }

  const descriptor = await fetchMetadata(`/releases/${channel}.json`, channel, artifact, fetcher);
  const version = launcherVersion(descriptor, channel);
  if (!version) throw unreadable();
  const filename = `appsweet-dokploy-bootstrap-${version}.json`;
  return { channel, artifact, version, filename, url: `${releaseRoot}backend-v${version}/${filename}` };
}

export async function startDownload(document, location, fetcher = fetch) {
  const status = document.getElementById('status');
  const link = document.getElementById('download');
  const retry = document.getElementById('retry');
  const title = document.getElementById('title');
  const artifact = new URLSearchParams(location.search).get('artifact');
  if (title && Object.hasOwn(artifacts, artifact)) title.textContent = artifacts[artifact].title;
  retry.hidden = true;
  link.hidden = true;
  link.removeAttribute('href');
  status.textContent = 'Finding your download…';
  try {
    const result = await resolveDownload(location.search, fetcher);
    link.href = result.url;
    link.textContent = `Download ${result.channel} ${result.version}`;
    link.hidden = false;
    status.textContent = 'Your download will start automatically. If it does not, use the button below.';
    // Keep the resolved link usable even if the browser blocks automatic downloads.
    try { location.assign(result.url); } catch { /* The visible link is the fallback. */ }
  } catch (error) {
    if (error instanceof NotPublishedError) {
      status.textContent = error.message;
      return;
    }
    status.textContent = error instanceof Error && !['TypeError', 'SyntaxError', 'TimeoutError', 'AbortError'].includes(error.name)
      ? error.message
      : 'We could not reach the release information. Please try again.';
    retry.hidden = false;
  }
}

if (typeof document !== 'undefined') {
  document.getElementById('retry').addEventListener('click', () => startDownload(document, window.location));
  startDownload(document, window.location);
}
