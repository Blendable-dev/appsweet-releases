const channels = new Set(['alpha', 'beta']);
const releaseRoot = 'https://github.com/Blendable-dev/appsweet-releases/releases/download/';

export async function resolveDownload(search, fetcher = fetch) {
  const params = new URLSearchParams(search);
  const channel = params.get('channel');
  if (!channels.has(channel) || params.get('artifact') !== 'dokploy-bootstrap') {
    throw new Error('Choose an alpha or beta Dokploy launcher from the installation guide.');
  }
  const response = await fetcher(`/releases/${channel}.json`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`The ${channel} release is unavailable. Please try again shortly.`);
  const descriptor = await response.json();
  const version = descriptor?.version;
  if (
    descriptor?.schemaVersion !== 2 || descriptor.channel !== channel ||
    typeof version !== 'string' || !/^\d+\.\d+\.\d+-build\.[1-9]\d*$/.test(version) ||
    descriptor.tag !== `backend-v${version}`
  ) {
    throw new Error('The release information could not be read. Please try again shortly.');
  }
  const filename = `appsweet-dokploy-bootstrap-${version}.json`;
  return { channel, version, filename, url: `${releaseRoot}backend-v${version}/${filename}` };
}

export async function startDownload(document, location, fetcher = fetch) {
  const status = document.getElementById('status');
  const link = document.getElementById('download');
  const retry = document.getElementById('retry');
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
