// Desktop update-channel contract (alpha and beta channels).
//
// The manifest shape is fixed by the Tauri updater plugin that consumes it, so this module adds
// the rules that shape cannot express: the package URL must be immutable, must belong to the
// version being offered and to the channel publishing it, the channels are Apple Silicon only,
// and a versioned path may never be republished with different bytes.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  assertSupportedSchemaVocabulary,
  validateValueAgainstSchema,
} from "../release-contract.mjs";

export const UPDATER_PLATFORM = "darwin-aarch64";
export const UPDATER_ARTIFACT = "AppSweet.app.tar.gz";

// The channels this contract may publish manifests for. `alpha` is the on-demand CD channel cut
// from main; `beta` is the reviewed release-please channel. Anything else is a spelling mistake
// that would otherwise mint a brand-new public channel URL.
export const UPDATE_CHANNELS = new Set(["alpha", "beta"]);

function assertChannel(channel) {
  if (!UPDATE_CHANNELS.has(channel)) {
    throw new Error(`unsupported desktop update channel: ${channel}`);
  }
}

/** The immutable base URL of a channel's updater artifacts. */
export function channelBaseUrl(channel = "beta") {
  assertChannel(channel);
  return `https://releases.appsweet.app/desktop/${channel}/${UPDATER_PLATFORM}`;
}

export const CHANNEL_BASE_URL = channelBaseUrl("beta");

const schema = JSON.parse(
  await readFile(new URL("./beta-channel.schema.json", import.meta.url), "utf8"),
);

assertSupportedSchemaVocabulary(schema);

/** The immutable, versioned URL of a release's updater package. */
export function updaterPackageUrl(version, channel = "beta") {
  return `${channelBaseUrl(channel)}/${version}/${UPDATER_ARTIFACT}`;
}

/** Build the channel manifest from the exact release inputs. */
export function buildChannelManifest({ version, notes, pubDate, signature, channel = "beta" }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [UPDATER_PLATFORM]: {
        signature,
        url: updaterPackageUrl(version, channel),
      },
    },
  };
}

export function validateChannelManifest(value, channel = "beta") {
  assertChannel(channel);
  return validateManifestForChannel(value, channel);
}

export function validateBetaChannelManifest(value) {
  return validateManifestForChannel(value, "beta");
}

function validateManifestForChannel(value, channel) {
  const schemaResult = validateValueAgainstSchema(value, schema);
  if (!schemaResult.valid) {
    return { valid: false, errors: schemaResult.errors };
  }

  const errors = [];
  const entry = value.platforms[UPDATER_PLATFORM];

  if (!entry.signature.trim()) {
    errors.push("the updater package signature must not be empty");
  }

  let url;
  try {
    url = new URL(entry.url);
  } catch {
    errors.push("the updater package URL is not a valid URL");
    return { valid: false, errors };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:") {
    errors.push("the updater package URL must use HTTPS");
  }
  if (url.username || url.password) {
    errors.push("the updater package URL must not embed credentials");
  }
  if (url.search || url.hash) {
    errors.push("the updater package URL must not carry a query or fragment");
  }
  if (segments.includes("latest")) {
    errors.push("the updater package URL must be immutable and must not contain a latest segment");
  }
  if (!segments.includes(value.version)) {
    errors.push(
      `the updater package URL must contain the offered version ${value.version}`,
    );
  }
  if (!segments.includes(UPDATER_PLATFORM)) {
    errors.push(`the updater package URL must target ${UPDATER_PLATFORM}`);
  }
  if (!segments.includes(channel)) {
    errors.push(`the updater package URL must belong to the ${channel} channel`);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Decide whether a versioned artifact may be written.
 *
 * Republishing a versioned path with different bytes would silently change what an already
 * offered version means, so it is refused. Re-uploading identical bytes is a harmless retry.
 */
export function assertImmutablePublication({ path, existingDigest, incomingDigest }) {
  if (!existingDigest) return { valid: true, action: "upload" };
  if (existingDigest === incomingDigest) return { valid: true, action: "skip" };
  return {
    valid: false,
    errors: [
      `${path} already exists with different bytes; versioned updater paths are immutable`,
    ],
  };
}

async function main(path, channel = "beta") {
  const value = JSON.parse(await readFile(path, "utf8"));
  const result = validateChannelManifest(value, channel);
  if (!result.valid) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`desktop ${channel} channel manifest is valid for ${value.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2], process.argv[3] ?? "beta");
}
