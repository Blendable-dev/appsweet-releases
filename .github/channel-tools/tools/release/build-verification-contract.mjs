import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseBuildVersion } from "./build-identity.mjs";
import { assertSupportedSchemaVocabulary, validateValueAgainstSchema } from "./release-contract.mjs";

const schema = JSON.parse(await readFile(new URL("../../deploy/self-host/build-verification.schema.json", import.meta.url), "utf8"));
assertSupportedSchemaVocabulary(schema);
const workflow = "https://github.com/Blendable-dev/local-app-sweet/.github/workflows/backend-alpha.yml@refs/heads/main";
const runs = "https://github.com/Blendable-dev/local-app-sweet/actions/runs/";

export function validateBuildVerification(value, membership = null) {
  const result = validateValueAgainstSchema(value, schema);
  if (!result.valid) return result;
  const errors = [];
  try {
    if (parseBuildVersion(value.version).sequence !== value.buildWorkflow.runNumber) errors.push("verification workflow sequence does not bind the build");
  } catch (error) { errors.push(error.message); }
  if (value.buildWorkflow.identity !== workflow || value.buildWorkflow.url !== `${runs}${value.buildWorkflow.runId}`) {
    errors.push("verification workflow must identify the exact protected main alpha run");
  }
  if (membership && (membership.channel !== "alpha" || value.version !== membership.version ||
    value.releaseManifestSha256 !== membership.releaseManifest.sha256 || value.signingKeyId !== membership.signingKeyId)) {
    errors.push("verification record does not bind the immutable alpha membership");
  }
  return { valid: errors.length === 0, errors };
}

export function createBuildVerification({ manifestBytes, anonymousVerification, workflowRunId }) {
  const manifest = JSON.parse(manifestBytes);
  const releaseManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (anonymousVerification?.version !== manifest.release.version ||
    anonymousVerification.manifestSha256 !== releaseManifestSha256 ||
    ["anonymousAssets", "anonymousImages", "signaturesAndInventory"].some((key) => anonymousVerification[key] !== "passed")) {
    throw new Error("durable verification requires successful exact-build anonymous evidence");
  }
  const record = { schemaVersion: 1, version: manifest.release.version, commitSha: manifest.release.commitSha,
    releaseManifestSha256, signingKeyId: manifest.signing.keyId,
    buildWorkflow: { identity: workflow, runId: workflowRunId,
      runNumber: parseBuildVersion(manifest.release.version).sequence, url: `${runs}${workflowRunId}` },
    checks: { releaseContracts: "passed", initializerCapability: "passed", anonymousAssets: "passed",
      anonymousImages: "passed", signaturesAndInventory: "passed" },
    scope: "publication-verification", liveAcceptance: "not-recorded" };
  const checked = validateBuildVerification(record);
  if (!checked.valid) throw new Error(checked.errors.join("; "));
  return record;
}
