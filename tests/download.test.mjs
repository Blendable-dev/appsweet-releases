import assert from 'node:assert/strict';
import test from 'node:test';
import { latestDesktopVersion, resolveDownload, startDownload } from '../download.mjs';

const query = '?channel=alpha&artifact=dokploy-bootstrap';
const descriptor = (version = '0.1.0-build.83', channel = 'alpha') => ({
  schemaVersion: 2, channel, version, tag: `backend-v${version}`,
});
const response = data => async () => ({ ok: true, json: async () => data });

test('same link follows channel advancement and uses no-store fetch', async () => {
  for (const version of ['0.1.0-build.83', '0.1.0-build.84']) {
    const result = await resolveDownload(query, async (url, options) => {
      assert.equal(url, '/releases/alpha.json');
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => descriptor(version) };
    });
    assert.equal(result.url, `https://github.com/Blendable-dev/appsweet-releases/releases/download/backend-v${version}/appsweet-dokploy-bootstrap-${version}.json`);
  }
});
test('beta resolves only beta and never consumes a metadata URL as a redirect', async () => {
  const data = { ...descriptor('0.1.0-build.83', 'beta'), releaseManifest: { url: 'https://example.org/' } };
  const result = await resolveDownload(query.replace('alpha', 'beta'), response(data));
  assert.equal(result.channel, 'beta');
  assert.equal(new URL(result.url).hostname, 'github.com');
});
test('invalid query fails without fetching', async () => {
  for (const search of ['', '?channel=../../private&artifact=dokploy-bootstrap', '?channel=nightly&artifact=dokploy-bootstrap', '?channel=alpha&artifact=https://example.org', '?channel=alpha&artifact=toString', '?channel=beta']) {
    await assert.rejects(resolveDownload(search, () => assert.fail('must not fetch')));
  }
});
test('malformed or mismatched metadata cannot produce a download', async () => {
  for (const data of [null, {}, descriptor('..'), descriptor('0.1.0-build.0'), descriptor('0.1.0-build.83', 'beta'), { ...descriptor(), tag: 'desktop-v1' }, { ...descriptor(), schemaVersion: 1 }]) {
    await assert.rejects(resolveDownload(query, response(data)));
  }
});
function ui() {
  const elements = Object.fromEntries(['status', 'download', 'retry'].map(id => [id, { hidden: true, removeAttribute(name) { delete this[name]; } }]));
  return { elements, document: { getElementById: id => elements[id] } };
}
test('initiates the download and retains the direct fallback when navigation is blocked', async () => {
  const { document, elements } = ui();
  let destination;
  await startDownload(document, { search: query, assign(url) { destination = url; throw new Error('blocked'); } }, response(descriptor()));
  assert.equal(elements.download.href, destination);
  assert.equal(elements.download.hidden, false);
  assert.match(elements.download.textContent, /alpha 0.1.0-build.83/);
  assert.equal(elements.retry.hidden, true);
});
test('HTTP, network, JSON and timeout failures never navigate; retry can recover', async () => {
  const failures = [async () => ({ ok: false }), async () => { throw new TypeError('network'); }, async () => ({ ok: true, json: async () => { throw new SyntaxError('json'); } }), async () => { throw new DOMException('timed out', 'TimeoutError'); }];
  for (const fetcher of failures) {
    const { document, elements } = ui();
    await startDownload(document, { search: query, assign() { assert.fail('must not navigate'); } }, fetcher);
    assert.equal(elements.download.hidden, true);
    assert.equal(elements.retry.hidden, false);
    assert.match(elements.status.textContent, /try again/i);
    let navigated = false;
    await startDownload(document, { search: query, assign() { navigated = true; } }, response(descriptor()));
    assert.ok(navigated);
    assert.equal(elements.retry.hidden, true);
  }
});

const desktopQuery = channel => `?channel=${channel}&artifact=desktop`;
const entry = version => ({
  version, sha256: 'a'.repeat(64), url: `https://releases.appsweet.app/desktop/builds/${version}/candidate.json`,
});
const catalog = (channel = 'alpha', versions = ['0.1.0-build.37', '0.1.0-build.38']) => ({
  schemaVersion: 1, channel, entries: versions.map(entry),
});

test('desktop resolves the newest catalog entry to the fixed public installer for every channel', async () => {
  for (const channel of ['alpha', 'beta', 'production']) {
    const result = await resolveDownload(desktopQuery(channel), async (url, options) => {
      assert.equal(url, `/desktop/channels/${channel}/catalog.json`);
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, status: 200, json: async () => catalog(channel) };
    });
    assert.equal(result.version, '0.1.0-build.38');
    assert.equal(result.url, `https://github.com/Blendable-dev/appsweet-releases/releases/download/desktop-build-v0.1.0-build.38/AppSweet-${channel}-aarch64.dmg`);
  }
});
test('production launcher resolves like the other channels', async () => {
  const result = await resolveDownload('?channel=production&artifact=dokploy-bootstrap', response(descriptor('0.1.0-build.90', 'production')));
  assert.equal(result.url, 'https://github.com/Blendable-dev/appsweet-releases/releases/download/backend-v0.1.0-build.90/appsweet-dokploy-bootstrap-0.1.0-build.90.json');
});
test('desktop never takes a URL from the catalog and refuses malformed catalogs', async () => {
  const foreign = { ...catalog(), entries: [{ ...entry('0.1.0-build.38'), url: 'https://example.org/candidate.json' }] };
  for (const data of [null, {}, foreign, catalog('beta'), { ...catalog(), schemaVersion: 2 }, { ...catalog(), entries: [] },
    catalog('alpha', ['0.1.0-build.38', '0.1.0-build.37']), catalog('alpha', ['0.1.0-build.38', '0.1.0-build.38']),
    catalog('alpha', ['0.1.0-build.0']), catalog('alpha', ['..']), { ...catalog(), entries: [{ ...entry('0.1.0-build.38'), sha256: 'x' }] }]) {
    await assert.rejects(resolveDownload(desktopQuery('alpha'), response(data)), /could not be read/);
  }
  assert.equal(latestDesktopVersion(catalog('alpha', ['0.1.0-build.9', '0.2.0-build.1']), 'alpha'), '0.2.0-build.1');
});
test('a channel with nothing published says so without a retry or navigation', async () => {
  for (const search of [desktopQuery('beta'), '?channel=beta&artifact=dokploy-bootstrap']) {
    const { document, elements } = ui();
    await startDownload(document, { search, assign() { assert.fail('must not navigate'); } }, async () => ({ ok: false, status: 404 }));
    assert.match(elements.status.textContent, /^No beta (desktop app|Dokploy launcher) is published yet\.$/);
    assert.equal(elements.retry.hidden, true);
    assert.equal(elements.download.hidden, true);
  }
});
test('the page names the artifact it is downloading', async () => {
  const { document, elements } = ui();
  elements.title = { textContent: 'Your AppSweet download' };
  await startDownload(document, { search: desktopQuery('alpha'), assign() {} }, async () => ({ ok: true, status: 200, json: async () => catalog() }));
  assert.equal(elements.title.textContent, 'Your AppSweet desktop app');
  assert.match(elements.download.textContent, /alpha 0.1.0-build.38/);
});
