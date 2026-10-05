import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateBackendChannelDescriptor } from "./backend-channel-contract.mjs";
import { compareSemver, validateChannelIndex } from "./channel-index-contract.mjs";
import { validateDesktopTree } from "./desktop/channel-tree.mjs";
/** The public keys installed clients have verified updates with — an
 * append-only set, because historical archives are immutable and stay
 * valid under the key that signed them even after a rotation. Resolution:
 * the vendored key set written at publication time, or the app repo's
 * current Tauri config. */
async function resolveUpdaterPublicKeys() {
  const vendored = await readIfPresent(
    new URL("./keys/updater-public-keys.txt", import.meta.url),
  );
  if (vendored) {
    return vendored
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  }
  const config = await readIfPresent(
    new URL(
      "../../clients/apps/desktop/appsweet/src-tauri/tauri.conf.json",
      import.meta.url,
    ),
  );
  if (!config) return [];
  const key = JSON.parse(config.toString("utf8")).plugins?.updater?.pubkey;
  return key ? [key] : [];
}

import { validateBuildVerification } from "./build-verification-contract.mjs";
import { parseBuildVersion } from "./build-identity.mjs";
const revocationLinePattern = /^sha256:[a-f0-9]{64}$/;
function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function parseRevocationList(text) {
  const revoked = new Set();
  const errors = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!revocationLinePattern.test(trimmed)) {
      errors.push(`malformed revocation entry: ${trimmed}`);
      continue;
    }
    revoked.add(trimmed);
  }
  return { revoked, errors };
}

/** Each release's Dokploy launcher is served beside the channel manifests, at an immutable
 * per-version path, so the install guide can show it inline (GitHub release downloads are not
 * readable cross-origin). The release manifest's hash is enforced when it is staged. */
export const DOKPLOY_LAUNCHER_DIRECTORY = "dokploy-bootstrap";
export const dokployLauncherName = (version) => `appsweet-dokploy-bootstrap-${version}.json`;

/** The signed, append-only record of every launcher published: `{schemaVersion: 1, launchers:
 * [{version, sha256}]}`, newest first. */
export const DOKPLOY_LAUNCHER_LIST = "launchers.json";
const launcherListKeys = ["launchers", "schemaVersion"];
const launcherEntryKeys = ["sha256", "version"];
const sameKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === keys.join();

/** Shape of the launcher list; an empty error list means valid. */
export function validateDokployLauncherList(value) {
  if (!sameKeys(value, launcherListKeys)) return ["must be an object with exactly schemaVersion and launchers"];
  if (value.schemaVersion !== 1) return ["schemaVersion must be 1"];
  if (!Array.isArray(value.launchers) || value.launchers.length === 0) return ["launchers must be a non-empty array"];
  const errors = [];
  for (const entry of value.launchers) {
    if (!sameKeys(entry, launcherEntryKeys)) {
      errors.push("each launcher must have exactly version and sha256");
      continue;
    }
    try { parseBuildVersion(entry.version); } catch (error) { errors.push(`${JSON.stringify(entry.version)}: ${error.message}`); }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      errors.push(`${JSON.stringify(entry.version)} sha256 must be 64 lowercase hex digits`);
    }
  }
  if (errors.length) return errors;
  for (let i = 1; i < value.launchers.length; i += 1) {
    if (compareSemver(value.launchers[i - 1].version, value.launchers[i].version) <= 0) {
      return ["launchers must be listed once each, in strictly descending version order"];
    }
  }
  return [];
}

/** A served launcher must be a Compose definition that pins exactly the version its name binds. */
export function validateDokployLauncher(bytes, version) {
  let launcher;
  try {
    launcher = JSON.parse(bytes.toString("utf8"));
  } catch {
    return ["must be JSON"];
  }
  const services = launcher?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return ["must be a Compose definition with services"];
  const pins = Object.values(services).flatMap((service) => {
    const environment = service?.environment;
    if (Array.isArray(environment)) {
      return environment.filter((entry) => typeof entry === "string" && entry.startsWith("APPSWEET_RELEASE_VERSION="))
        .map((entry) => entry.slice("APPSWEET_RELEASE_VERSION=".length));
    }
    return environment && typeof environment === "object" && "APPSWEET_RELEASE_VERSION" in environment
      ? [environment.APPSWEET_RELEASE_VERSION] : [];
  });
  if (pins.length === 0 || pins.some((pin) => pin !== version)) return [`must pin APPSWEET_RELEASE_VERSION to ${version}`];
  return [];
}

const channelValidators = Object.fromEntries(["alpha", "beta"].map((channel) =>
  [channel, (value) => validateBackendChannelDescriptor(value, { channel })]));

/**
 * Validate a channel repository tree: the served content of
 * releases.appsweet.app, rooted at the directory that contains
 * `install.sh` and `releases/`.
 *
 * `verifyBundle(filePath, bundlePath, keyId)` must throw (or reject) when
 * the Sigstore bundle does not sign the file's exact bytes under the key
 * with the given ID. Pass `null` to skip signature verification.
 */
export async function validateChannelTree(
  root,
  { verifyBundle = null, updaterPublicKeys = undefined } = {},
) {
  const errors = [];
  const releasesDir = join(root, "releases");
  const bundlesToVerify = [];

  // A channel may legitimately carry only desktop content before the first
  // backend publication — the repository's own bootstrap state. The backend
  // section is required as soon as any of it exists; the desktop section
  // below is validated either way.
  let releasesDirExists = true;
  try {
    await stat(releasesDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    releasesDirExists = false;
  }
  const installer = await readIfPresent(join(root, "install.sh"));
  const backendPresent = releasesDirExists || installer !== null;
  let index = { channels: {} };

  if (backendPresent) {
  if (!installer || installer.length === 0) {
    errors.push("install.sh must exist and be non-empty");
  } else if (!(await readIfPresent(join(root, "install.sh.sigstore.json")))) {
    // The installer is executed through the streamed-shell path before any
    // of its internal verification can protect the operator, so the channel
    // must bind its exact bytes to the release signing key.
    errors.push("install.sh.sigstore.json is missing");
  }

  const revocationBytes = await readIfPresent(
    join(releasesDir, "revoked-key-ids.txt"),
  );
  let revoked = new Set();
  if (!revocationBytes) {
    errors.push("releases/revoked-key-ids.txt must exist");
  } else {
    const parsed = parseRevocationList(revocationBytes.toString("utf8"));
    errors.push(...parsed.errors);
    revoked = parsed.revoked;
  }

  const indexBytes = await readIfPresent(join(releasesDir, "index.json"));
  if (!indexBytes) {
    errors.push("releases/index.json must exist");
    return { valid: false, errors };
  }
  try {
    index = JSON.parse(indexBytes.toString("utf8"));
  } catch {
    return { valid: false, errors: [...errors, "releases/index.json must be JSON"] };
  }
  const indexResult = validateChannelIndex(index);
  if (!indexResult.valid) {
    return { valid: false, errors: [...errors, ...indexResult.errors] };
  }

  bundlesToVerify.push({ file: join(releasesDir, "index.json") });
  if (installer && installer.length > 0) {
    bundlesToVerify.push({ file: join(root, "install.sh") });
  }

  // Everything under releases/ is served publicly; anything outside the
  // documented layout is a boundary violation, not clutter.
  const allowedRoot = new Set([
    "index.json",
    "index.json.sigstore.json",
    "revoked-key-ids.txt",
    "verification",
    DOKPLOY_LAUNCHER_DIRECTORY,
    ...Object.keys(index.channels).flatMap((channel) => [
      channel,
      `${channel}.json`,
      `${channel}.json.sigstore.json`,
    ]),
  ]);
  for (const name of await readdir(releasesDir)) {
    if (!allowedRoot.has(name)) {
      errors.push(`releases/${name} is outside the published channel layout`);
    }
  }

  for (const [channel, entry] of Object.entries(index.channels)) {
    const validateDescriptor = channelValidators[channel];
    const channelDir = join(releasesDir, channel);

    const listed = new Map();
    for (const published of entry.versions) {
      listed.set(`${published.version}.json`, published);
    }

    let present = [];
    try {
      present = await readdir(channelDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      errors.push(`releases/${channel}/ must exist`);
      continue;
    }
    for (const name of present) {
      if (name.endsWith(".json.sigstore.json")) {
        if (!listed.has(name.slice(0, -".sigstore.json".length))) {
          errors.push(
            `releases/${channel}/${name} is not part of the published layout`,
          );
        }
      } else if (name.endsWith(".json")) {
        if (!listed.has(name)) {
          errors.push(`releases/${channel}/${name} is not listed in the index`);
        }
      } else {
        errors.push(
          `releases/${channel}/${name} is not part of the published layout`,
        );
      }
    }

    for (const [name, published] of listed) {
      const manifestPath = join(channelDir, name);
      const bytes = await readIfPresent(manifestPath);
      if (!bytes) {
        errors.push(`releases/${channel}/${name} is listed but missing`);
        continue;
      }
      if (sha256Hex(bytes) !== published.manifestSha256) {
        errors.push(
          `releases/${channel}/${name} does not match its index sha256`,
        );
        continue;
      }
      let descriptor;
      try {
        descriptor = JSON.parse(bytes.toString("utf8"));
      } catch {
        errors.push(`releases/${channel}/${name} must be JSON`);
        continue;
      }
      const result = validateDescriptor(descriptor);
      if (!result.valid) {
        errors.push(
          ...result.errors.map((e) => `releases/${channel}/${name}: ${e}`),
        );
        continue;
      }
      if (descriptor.version !== published.version) {
        errors.push(`releases/${channel}/${name} declares a different version`);
      }
      if (descriptor.publishedAt !== published.publishedAt) {
        errors.push(
          `releases/${channel}/${name} publishedAt disagrees with the index`,
        );
      }
      if (!(await readIfPresent(`${manifestPath}.sigstore.json`))) {
        errors.push(`releases/${channel}/${name}.sigstore.json is missing`);
      } else {
        bundlesToVerify.push({
          file: manifestPath,
          keyId: descriptor.signingKeyId,
        });
      }
    }

    const latestPath = join(releasesDir, `${channel}.json`);
    const latestBytes = await readIfPresent(latestPath);
    const latestVersioned = await readIfPresent(
      join(channelDir, `${entry.latest}.json`),
    );
    if (!latestBytes) {
      errors.push(`releases/${channel}.json must exist`);
    } else if (latestVersioned && !latestBytes.equals(latestVersioned)) {
      errors.push(
        `releases/${channel}.json must be byte-identical to releases/${channel}/${entry.latest}.json`,
      );
    } else {
      const latestDescriptor = JSON.parse(latestBytes.toString("utf8"));
      if (revoked.has(latestDescriptor.signingKeyId)) {
        errors.push(
          `releases/${channel}.json is signed by a revoked key; the latest pointer must move`,
        );
      }
      if (
        revocationBytes &&
        latestDescriptor.revocations.sha256 !==
          sha256Hex(revocationBytes)
      ) {
        errors.push(
          `releases/${channel}.json revocations.sha256 must match the served revocation list`,
        );
      }
      if (!(await readIfPresent(`${latestPath}.sigstore.json`))) {
        errors.push(`releases/${channel}.json.sigstore.json is missing`);
      } else {
        bundlesToVerify.push({
          file: latestPath,
          keyId: latestDescriptor.signingKeyId,
        });
      }
    }
  }

  const verificationDir = join(releasesDir, "verification");
  const records = await readdir(verificationDir).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  for (const name of records) {
    if (name.endsWith(".json.sigstore.json") && records.includes(name.slice(0, -".sigstore.json".length))) continue;
    const version = name.slice(0, -5);
    if (!name.endsWith(".json") || !index.channels.alpha?.versions.some((entry) => entry.version === version)) {
      errors.push(`verification/${name} has no indexed alpha build`);
      continue;
    }
    try {
      const recordPath = join(verificationDir, name);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      const membership = JSON.parse(await readFile(join(releasesDir, "alpha", name), "utf8"));
      const checked = validateBuildVerification(record, membership);
      if (!checked.valid) errors.push(...checked.errors);
      else if (!(await readIfPresent(`${recordPath}.sigstore.json`))) errors.push(`verification/${name} signature is missing`);
      else bundlesToVerify.push({ file: recordPath, keyId: record.signingKeyId });
    } catch (error) { errors.push(`verification/${name}: ${error.message}`); }
  }

  // Launchers exist only for versions some channel publishes; older releases predate them. The
  // signed, append-only launcher list records every launcher ever published, so a deleted or
  // altered launcher — the oldest or the only one included — cannot go unnoticed, and every
  // indexed version from the oldest listed one on must be listed. It is a separate file because
  // installed backends parse index entries with closed (deny_unknown_fields) types.
  const launcherDir = join(releasesDir, DOKPLOY_LAUNCHER_DIRECTORY);
  const launcherPrefix = `releases/${DOKPLOY_LAUNCHER_DIRECTORY}`;
  const indexedVersions = new Set(Object.values(index.channels)
    .flatMap((entry) => entry.versions.map(({ version }) => version)));
  const launcherNames = await readdir(launcherDir).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const listPath = join(launcherDir, DOKPLOY_LAUNCHER_LIST);
  const listName = `${launcherPrefix}/${DOKPLOY_LAUNCHER_LIST}`;
  const listBytes = await readIfPresent(listPath);
  if (!listBytes) {
    if (launcherNames.length > 0) errors.push(`${listName} is missing: served launchers must be recorded in the signed launcher list`);
  } else {
    if (!(await readIfPresent(`${listPath}.sigstore.json`))) errors.push(`${listName}.sigstore.json is missing`);
    else bundlesToVerify.push({ file: listPath });
    let list;
    try {
      list = JSON.parse(listBytes.toString("utf8"));
    } catch {
      errors.push(`${listName} must be JSON`);
    }
    const listErrors = list === undefined ? [] : validateDokployLauncherList(list);
    errors.push(...listErrors.map((error) => `${listName}: ${error}`));
    if (list !== undefined && listErrors.length === 0) {
      const listedNames = new Set();
      for (const { version, sha256 } of list.launchers) {
        const name = dokployLauncherName(version);
        listedNames.add(name);
        if (!indexedVersions.has(version)) errors.push(`${listName} lists ${version}, which no channel indexes`);
        const bytes = await readIfPresent(join(launcherDir, name));
        if (!bytes) {
          errors.push(`${launcherPrefix}/${name} is listed but missing`);
          continue;
        }
        if (sha256Hex(bytes) !== sha256) {
          errors.push(`${launcherPrefix}/${name} does not match its listed sha256`);
          continue;
        }
        errors.push(...validateDokployLauncher(bytes, version).map((error) => `${launcherPrefix}/${name} ${error}`));
      }
      for (const name of launcherNames) {
        if (name === DOKPLOY_LAUNCHER_LIST || name === `${DOKPLOY_LAUNCHER_LIST}.sigstore.json`) continue;
        if (!listedNames.has(name)) errors.push(`${launcherPrefix}/${name} is not in the signed launcher list`);
      }
      const oldest = list.launchers.at(-1).version;
      for (const version of indexedVersions) {
        if (compareSemver(version, oldest) >= 0 && !listedNames.has(dokployLauncherName(version))) {
          errors.push(`${listName} does not list ${version}: every indexed version from ${oldest} on serves its launcher`);
        }
      }
    }
  }

  if (!(await readIfPresent(join(releasesDir, "index.json.sigstore.json")))) {
    errors.push("releases/index.json.sigstore.json is missing");
  }
  }

  try {
    await validateDesktopTree(root, updaterPublicKeys ?? await resolveUpdaterPublicKeys());
  } catch (error) { errors.push(error.message); }

  if (verifyBundle && errors.length === 0) {
    for (const { file, keyId } of bundlesToVerify) {
      try {
        await verifyBundle(file, `${file}.sigstore.json`, keyId ?? null);
      } catch (error) {
        errors.push(`signature verification failed for ${file}: ${error.message}`);
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function cosignVerifier() {
  const keysDir = new URL("./keys/", import.meta.url);
  const verifyWithKey = async (filePath, bundlePath, keyHex) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("cosign", [
      "verify-blob",
      "--key",
      new URL(`trusted/${keyHex}.pub`, keysDir).pathname,
      "--bundle",
      bundlePath,
      "--insecure-ignore-tlog",
      filePath,
    ]);
  };
  return async (filePath, bundlePath, keyId) => {
    if (keyId) {
      await verifyWithKey(filePath, bundlePath, keyId.replace(/^sha256:/, ""));
      return;
    }
    // Files with no recorded signing identity (the index, the installer)
    // were signed by whichever reviewed key was active at their last
    // publication — which, across a rotation, is not necessarily the key
    // active now. Accept any trusted, non-revoked key from the reviewed
    // keyring, active key first.
    const active = (
      await readFile(new URL("active-key-id.txt", keysDir), "utf8")
    )
      .trim()
      .replace(/^sha256:/, "");
    const { revoked } = parseRevocationList(
      await readFile(new URL("revoked-key-ids.txt", keysDir), "utf8"),
    );
    const trusted = (await readdir(new URL("trusted/", keysDir)))
      .filter((name) => name.endsWith(".pub"))
      .map((name) => name.slice(0, -".pub".length))
      .filter((hex) => !revoked.has(`sha256:${hex}`))
      .sort((a, b) => (a === active ? -1 : b === active ? 1 : 0));
    let lastError = new Error("no trusted, non-revoked signing keys exist");
    for (const keyHex of trusted) {
      try {
        await verifyWithKey(filePath, bundlePath, keyHex);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
}

async function main(argv) {
  let cosign = false;
  let updaterKeysPath = null;
  let root = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cosign") cosign = true;
    else if (argv[i] === "--updater-keys") {
      i += 1;
      updaterKeysPath = argv[i];
    } else root = argv[i];
  }
  if (!root || !(await stat(root)).isDirectory()) {
    console.error(
      "usage: channel-tree-contract.mjs [--cosign] [--updater-keys <file>] <channel-tree-root>",
    );
    process.exitCode = 2;
    return;
  }
  // --updater-keys reads the retained key set from an explicit file, so the
  // validator can run from a trusted checkout while treating a cloned
  // channel repository purely as data.
  let updaterPublicKeys;
  if (updaterKeysPath) {
    updaterPublicKeys = (await readFile(updaterKeysPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  }
  const result = await validateChannelTree(root, {
    verifyBundle: cosign ? cosignVerifier() : null,
    updaterPublicKeys,
  });
  if (!result.valid) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}
