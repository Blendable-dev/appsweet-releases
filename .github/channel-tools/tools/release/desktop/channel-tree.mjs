import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { verifyCandidate, verifyCatalog } from "./catalog.mjs";
import { candidateHash, releaseOrigin } from "./candidate-policy.mjs";
import { verifyCompleteSignature as verifyUpdaterSignature } from "./verify-updater-signature.mjs";

export async function validateDesktopTree(root, keys) {
  const directory = join(root, "desktop");
  const files = new Set();
  async function walk(path, prefix = "") {
    for (const name of await readdir(path)) {
      const relative = `${prefix}${name}`;
      const info = await lstat(join(path, name));
      if (info.isSymbolicLink()) throw new Error(`desktop/${relative}: symlinks are forbidden`);
      if (info.isDirectory()) await walk(join(path, name), `${relative}/`);
      else if (info.isFile()) files.add(relative);
      else throw new Error(`desktop/${relative}: unsupported entry`);
    }
  }
  try { await walk(directory); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!files.size) return;
  if (!keys?.length) throw new Error("desktop content has no trusted updater public key");
  const allowed = new Set();
  async function bytes(path) { allowed.add(path); return readFile(join(directory, path)); }
  function authenticate(operation) {
    for (const key of keys) { try { return operation(key); } catch { /* try another reviewed retained key */ } }
    throw new Error("desktop metadata failed authentication or contract validation");
  }
  const candidates = new Map();
  for (const channel of ["alpha", "beta"]) {
    const path = `channels/${channel}/catalog.json`;
    if (!files.has(path)) continue;
    const catalogBytes = await bytes(path);
    const catalogSignature = (await bytes(`${path}.sig`)).toString("utf8");
    const catalog = authenticate((key) => verifyCatalog(catalogBytes, catalogSignature, key, channel));
    for (const entry of catalog.entries) {
      const base = `builds/${entry.version}`;
      let candidate = candidates.get(entry.version);
      if (!candidate) {
        const payload = await bytes(`${base}/candidate.json`);
        const signature = (await bytes(`${base}/candidate.json.sig`)).toString("utf8");
        candidate = authenticate((key) => verifyCandidate(payload, signature, key));
        if (candidate.version !== entry.version) throw new Error("desktop candidate path identity mismatch");
        candidates.set(entry.version, candidate);
      }
      if (candidateHash(await bytes(`${base}/candidate.json`)) !== entry.sha256) throw new Error("desktop membership hash mismatch");
      const variant = candidate.variants[channel];
      const prefix = `${base}/${channel}/darwin-aarch64`;
      const archive = await bytes(`${prefix}/AppSweet.app.tar.gz`);
      const signature = (await bytes(`${prefix}/AppSweet.app.tar.gz.sig`)).toString("utf8").trim();
      if (candidateHash(archive) !== variant.updater.sha256 || signature !== variant.updater.signature
        || !keys.some((key) => verifyUpdaterSignature({ packageBytes: archive, signatureFile: signature, publicKeyField: key }).valid)) throw new Error("desktop archive digest/signature mismatch");
      const transport = JSON.parse((await bytes(`${prefix}/updater.json`)).toString("utf8"));
      const expected = transportManifest(candidate, channel);
      if (JSON.stringify(transport) !== JSON.stringify(expected)) throw new Error("desktop transport does not bind the candidate");
    }
  }
  for (const path of files) if (!allowed.has(path)) throw new Error(`desktop/${path}: not an advertised immutable artifact (Production publication is disabled)`);
}

export function transportManifest(candidate, channel) {
  const asset = candidate.variants[channel].updater;
  return { version: candidate.version, notes: candidate.notes, pub_date: candidate.publishedAt,
    platforms: { "darwin-aarch64": { signature: asset.signature, url: asset.url } } };
}

export function publicPath(url) {
  if (!url.startsWith(`${releaseOrigin}/desktop/`)) throw new Error("not a public desktop artifact");
  return url.slice(`${releaseOrigin}/`.length);
}
