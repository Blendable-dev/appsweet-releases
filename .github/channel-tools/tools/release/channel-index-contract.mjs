import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseBuildVersion } from "./build-identity.mjs";
import {
  assertSupportedSchemaVocabulary,
  validateValueAgainstSchema,
} from "./release-contract.mjs";

const buildIndexSchema = JSON.parse(await readFile(
  new URL("../../deploy/self-host/channel-index-v2.schema.json", import.meta.url), "utf8",
));
assertSupportedSchemaVocabulary(buildIndexSchema);

const identifierPattern = /^(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)$/;

function comparePrereleaseIdentifiers(left, right) {
  const leftNumeric = /^[0-9]+$/.test(left);
  const rightNumeric = /^[0-9]+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemver(left, right) {
  const parse = (value) => {
    const [core, ...prerelease] = value.split("-");
    return {
      core: core.split(".").map(BigInt),
      prerelease: prerelease.join("-"),
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  const aIds = a.prerelease.split(".");
  const bIds = b.prerelease.split(".");
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i += 1) {
    if (aIds[i] === undefined) return -1;
    if (bIds[i] === undefined) return 1;
    const order = comparePrereleaseIdentifiers(aIds[i], bIds[i]);
    if (order !== 0) return order;
  }
  return 0;
}

export function validateChannelIndex(value) {
  const schemaResult = validateValueAgainstSchema(value, buildIndexSchema);
  if (!schemaResult.valid) {
    return { valid: false, errors: schemaResult.errors };
  }

  const errors = [];
  if (Object.keys(value.channels).length === 0) errors.push("index must contain a published channel");
  for (const [channel, entry] of Object.entries(value.channels)) {
    const versions = entry.versions.map((published) => published.version);
    if (new Set(versions).size !== versions.length) {
      errors.push(`${channel} lists a version more than once`);
    }
    for (let i = 1; i < versions.length; i += 1) {
      if (compareSemver(versions[i - 1], versions[i]) <= 0) {
        errors.push(
          `${channel} versions must be listed in strictly descending order`,
        );
        break;
      }
    }
    if (versions[0] !== entry.latest) {
      errors.push(`${channel} latest must be the first listed version`);
    }
    for (const published of entry.versions) {
      try { parseBuildVersion(published.version); } catch (error) { errors.push(error.message); }
      if (published.channel !== channel) {
        errors.push(
          `${channel} ${published.version} must carry its own channel identity`,
        );
      }
      if (
        published.manifestUrl !==
        `https://releases.appsweet.app/releases/${channel}/${published.version}.json`
      ) {
        errors.push(
          `${channel} ${published.version} manifestUrl must bind its version`,
        );
      }
      for (const identifier of (published.version.split("-").slice(1).join("-") || "")
        .split(".")
        .filter(Boolean)) {
        if (!identifierPattern.test(identifier)) {
          errors.push(
            `${channel} ${published.version} has a malformed prerelease identifier`,
          );
        }
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

async function main(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  const result = validateChannelIndex(value);
  if (!result.valid) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv[2]);
}
