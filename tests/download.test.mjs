import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDownload, startDownload } from '../download.mjs';

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
  for (const search of ['', '?channel=../../private&artifact=dokploy-bootstrap', '?channel=production&artifact=dokploy-bootstrap', '?channel=alpha&artifact=https://example.org']) {
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
