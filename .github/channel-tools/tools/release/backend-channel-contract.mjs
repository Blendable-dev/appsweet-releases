import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertSupportedSchemaVocabulary, validateValueAgainstSchema, validateReleaseManifest } from "./release-contract.mjs";
import { compareBuildVersions, parseBuildVersion } from "./build-identity.mjs";

const schema = JSON.parse(await readFile(new URL("../../deploy/self-host/backend-channel.schema.json", import.meta.url), "utf8"));
assertSupportedSchemaVocabulary(schema);
const base = "https://releases.appsweet.app/";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Validates structure and binding. The caller must verify signatures before trusting the result. */
export function validateBackendChannelDescriptor(value, { channel, acceptanceChannelId = null } = {}) {
  if (!["alpha", "beta"].includes(channel)) return { valid: false, errors: ["expected channel must be alpha or beta"] };
  if (acceptanceChannelId !== null) return { valid: false, errors: ["private acceptance channels are not supported"] };
  const result = validateValueAgainstSchema(value, schema);
  if (!result.valid) return result;
  const errors = [];
  try { parseBuildVersion(value.version); } catch (error) { errors.push(error.message); }
  if (value.channel !== channel) errors.push("descriptor does not bind the selected channel");
  if (value.tag !== `backend-v${value.version}`) errors.push("tag must bind the build version");
  if (value.releaseManifest.url !== `https://github.com/Blendable-dev/appsweet-releases/releases/download/${value.tag}/release.json`) errors.push("manifest URL must bind the immutable public build");
  const prefix = base;
  if (value.revocations.url !== `${prefix}releases/revoked-key-ids.txt`) errors.push("revocations must bind the channel origin");
  return { valid: errors.length === 0, errors };
}

/** Assembles unsigned membership for a previously verified manifest; never rewrites build bytes. */
export function createBuildMembership({ manifestBytes, manifestSha256, channel, publishedAt, revocationsSha256 }) {
  if (digest(manifestBytes) !== manifestSha256) throw new Error("build manifest hash changed");
  const manifest = JSON.parse(manifestBytes.toString());
  const checked = validateReleaseManifest(manifest);
  if (!checked.valid || manifest.schemaVersion !== 2) throw new Error(`not an installable immutable build: ${checked.errors?.join(", ")}`);
  const descriptor = {
    schemaVersion: 2, channel, version: manifest.release.version, tag: manifest.release.tag,
    publishedAt, releaseReadiness: manifest.release.readiness,
    deploymentDefinitionSha256: manifest.deploymentDefinitionSha256,
    releaseManifest: { url: `https://github.com/Blendable-dev/appsweet-releases/releases/download/${manifest.release.tag}/release.json`, sha256: manifestSha256 },
    signingKeyId: manifest.signing.keyId,
    revocations: { url: `${base}releases/revoked-key-ids.txt`, sha256: revocationsSha256 },
  };
  const result = validateBackendChannelDescriptor(descriptor, { channel });
  if (!result.valid) throw new Error(result.errors.join("; "));
  return descriptor;
}

/** Requires an authenticated alpha membership; beta authorization/signing belongs to the publisher. */
export function promoteBuildMembership({ alpha, manifestBytes, publishedAt, revocationsSha256, previousBeta = null }) {
  const checked = validateBackendChannelDescriptor(alpha, { channel: "alpha" });
  if (!checked.valid) throw new Error(checked.errors.join("; "));
  const beta = createBuildMembership({ manifestBytes, manifestSha256: alpha.releaseManifest.sha256,
    channel: "beta", publishedAt, revocationsSha256 });
  for (const key of ["version", "tag", "releaseReadiness", "deploymentDefinitionSha256", "signingKeyId"]) {
    if (alpha[key] !== beta[key]) throw new Error(`alpha membership disagrees with the build: ${key}`);
  }
  if (alpha.releaseManifest.url !== beta.releaseManifest.url) throw new Error("alpha manifest location changed");
  if (previousBeta !== null) {
    const prior = validateBackendChannelDescriptor(previousBeta, { channel: "beta" });
    if (!prior.valid) throw new Error("previous beta membership is invalid");
    if (compareBuildVersions(beta.version, previousBeta.version) <= 0) {
      if (beta.version === previousBeta.version && JSON.stringify(beta.releaseManifest) === JSON.stringify(previousBeta.releaseManifest) &&
        beta.deploymentDefinitionSha256 === previousBeta.deploymentDefinitionSha256) return structuredClone(previousBeta);
      throw new Error("beta promotion cannot replace or move behind an existing build");
    }
  }
  return beta;
}
