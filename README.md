# AppSweet release channels

Static release-channel metadata and update artifacts for AppSweet, served at
https://releases.appsweet.app via GitHub Pages.

- `desktop/<channel>/<target>/latest.json` — Tauri updater manifests
- `desktop/<channel>/<target>/<version>/` — update archives referenced by the manifests
- `releases/beta.json` — backend release channel consumed by the self-host installer

Content here is published exclusively by CI in the private product repository
(`Blendable-dev/local-app-sweet`) after its signing and licence gates pass. Nothing is
edited by hand; the signatures inside the manifests are what installed clients trust,
so this repo's visibility adds no authority — it is a delivery path, not a trust root.

A dedicated host: the apex appsweet.app is untouched and stays yours to serve however you like.
