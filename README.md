# AppSweet release channels

Static release-channel metadata and update artifacts for AppSweet, served at
https://releases.appsweet.app via GitHub Pages.

- `download.html?channel=alpha&artifact=dokploy-bootstrap` — automatically download the current
  alpha Dokploy launcher; use `channel=beta` for beta once published. A fallback button links to
  the resolved immutable asset, and the page links to other versions. This is browser navigation,
  not signature verification; installation retains its release-verification checks.
- `install.sh` — the one-line self-host installer
- `releases/beta.json` (+ `.sigstore.json`) — backend beta channel: the latest release, consumed by
  the self-host installer; always a byte-copy of that version's per-version manifest
- `releases/beta/<version>.json` (+ `.sigstore.json`) — immutable per-version manifests; every version
  ever published stays addressable here
- `releases/index.json` (+ `.sigstore.json`) — signed enumeration of all published versions per
  channel, regenerated on every publication
- `releases/revoked-key-ids.txt` — revoked release-signing key IDs
- `desktop/<channel>/<target>/latest.json` — Tauri updater manifests
- `desktop/<channel>/<target>/<version>/` — update archives referenced by the manifests

## Rules

- **Published versions are immutable.** A per-version manifest is never rewritten or deleted.
  Withdrawing a release means revoking its signing key ID and moving the latest pointer — the
  manifest stays.
- **Release artifacts and channel metadata are published exclusively by CI** in the private product repository
  (`Blendable-dev/local-app-sweet`), by the promotion workflows after their signing and licence gates
  pass. Each publication is a single commit carrying the manifest, its signature, the updated latest
  pointer, and the regenerated signed index.
- **Manual changes to release artifacts or channel metadata are break-glass only** — reserved for recovering from a publication failure, and
  they must still pass this repo's validation workflow, which verifies every signature against the
  pinned trusted key.

This repo's visibility adds no authority: the signatures inside the manifests are what installed
clients trust, so it is a delivery path, not a trust root.

A dedicated host: the apex appsweet.app is untouched and stays yours to serve however you like.

## Static download page

The static navigation page is maintained through reviewed pull requests. It does not modify
release metadata. Run `node --test tests/download.test.mjs` to check channel resolution and failure
recovery. GitHub Pages publishes the page after merge; dependent installation-guide links must
not publish before it is available.
