import { verifyCompleteSignature as verifyUpdaterSignature } from "./verify-updater-signature.mjs";
import { validateCandidate, candidateHash, parseCandidateVersion, publicationDecision, compareCandidateVersions, releaseOrigin } from "./candidate-policy.mjs";

function check(ok, message) { if (!ok) throw new Error(message); }

/** Authenticate exact bytes before parsing or interpreting notes, URLs or requirements. */
export function authenticatedJson(bytes, signature, publicKey, maximum = 4 * 1024 * 1024) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, "metadata exceeds size limit");
  const result = verifyUpdaterSignature({ packageBytes: bytes, signatureFile: signature, publicKeyField: publicKey });
  check(result.valid, "metadata signature verification failed");
  return JSON.parse(bytes.toString("utf8"));
}

export function verifyCandidate(bytes, signature, publicKey) {
  return validateCandidate(authenticatedJson(bytes, signature, publicKey, 256 * 1024));
}

export function validateCatalog(catalog, channel) {
  check(["alpha", "beta", "production"].includes(channel), "unknown channel");
  check(catalog && Object.keys(catalog).sort().join() === "channel,entries,schemaVersion", "invalid catalog fields");
  check(catalog.schemaVersion === 1 && catalog.channel === channel, "catalog identity mismatch");
  check(Array.isArray(catalog.entries) && catalog.entries.length > 0 && catalog.entries.length <= 10000, "invalid catalog entries");
  let previous;
  for (const entry of catalog.entries) {
    check(entry && Object.keys(entry).sort().join() === "sha256,url,version", "invalid catalog entry");
    parseCandidateVersion(entry.version);
    check(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256), "invalid candidate hash");
    check(entry.url === `${releaseOrigin}/desktop/builds/${entry.version}/candidate.json`, "invalid candidate URL");
    check(!previous || compareCandidateVersions(previous, entry.version) < 0, "history must be strictly increasing");
    previous = entry.version;
  }
  return catalog;
}

export function verifyCatalog(bytes, signature, publicKey, channel) {
  return validateCatalog(authenticatedJson(bytes, signature, publicKey), channel);
}

/** Caller signs the result inside its CAS loop; never rebase previously signed JSON. */
export function advanceCatalog(current, candidateBytes, channel) {
  const candidate = validateCandidate(JSON.parse(candidateBytes.toString("utf8")));
  const incoming = { version: candidate.version, sha256: candidateHash(candidateBytes) };
  if (current) validateCatalog(current, channel);
  const existing = current?.entries.find((entry) => entry.version === candidate.version);
  // A delayed retry must also authenticate the historical identity, not merely compare head order.
  if (existing && existing.sha256 !== incoming.sha256) throw new Error("immutable historical candidate conflict");
  const head = current?.entries.at(-1);
  const action = publicationDecision(channel, head ? { version: head.version, sha256: head.sha256 } : null, incoming);
  if (action !== "advance") return { action, catalog: current };
  const entry = { ...incoming, url: `${releaseOrigin}/desktop/builds/${candidate.version}/candidate.json` };
  return { action, catalog: validateCatalog({ schemaVersion: 1, channel, entries: [...(current?.entries ?? []), entry] }, channel) };
}
