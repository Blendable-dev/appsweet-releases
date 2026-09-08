// Pure policy; callers MUST authenticate metadata before using these decisions for delivery.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const channels = Object.freeze(JSON.parse(readFileSync(new URL("./channels.json", import.meta.url))));
export const platform = "darwin-aarch64";
export const releaseOrigin = "https://releases.appsweet.app";
export const installerRepository = "https://github.com/Blendable-dev/local-app-sweet";
export function installerUrl(version, channel) {
  return `${installerRepository}/releases/download/desktop-build-v${version}/AppSweet-${channel}-aarch64.dmg`;
}
const variants = ["alpha", "beta", "production"];
const integer = /^(0|[1-9]\d*)$/;
const digest = /^[a-f0-9]{64}$/;

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

function record(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
  requireValue(Object.keys(value).sort().join() === [...keys].sort().join(), `${label}: unexpected or missing fields`);
}

function numbers(parts) {
  requireValue(parts.every((p) => integer.test(p) && Number.isSafeInteger(Number(p))), "invalid version");
  return parts.map(Number);
}

export function parseCandidateVersion(version) {
  requireValue(typeof version === "string", "invalid candidate version");
  const match = /^(\d+)\.(\d+)\.(\d+)-build\.(\d+)$/.exec(version);
  requireValue(match, "invalid candidate version");
  const parts = numbers(match.slice(1));
  requireValue(parts[3] > 0, "candidate sequence must be positive");
  return parts;
}

function apiVersion(version) {
  requireValue(typeof version === "string", "invalid API version");
  const parts = version.split(".");
  requireValue(parts.length === 3, "invalid API version");
  return numbers(parts);
}

function compareParts(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function compareCandidateVersions(a, b) {
  return compareParts(parseCandidateVersion(a), parseCandidateVersion(b));
}

function compareApi(a, b) {
  return compareParts(apiVersion(a), apiVersion(b));
}

function capabilities(value) {
  requireValue(Array.isArray(value) && value.length <= 128, "invalid capabilities");
  requireValue(value.every((s) => typeof s === "string" && /^[a-z][a-z0-9_.-]{0,99}$/.test(s)), "invalid capability");
  requireValue(new Set(value).size === value.length, "duplicate capability");
}

export function candidateHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateCandidate(candidate) {
  record(candidate, ["schemaVersion", "version", "sourceCommit", "publishedAt", "notes", "requirements", "variants"], "candidate");
  requireValue(candidate.schemaVersion === 1, "unsupported candidate schema");
  parseCandidateVersion(candidate.version);
  requireValue(/^[a-f0-9]{40}$/.test(candidate.sourceCommit), "invalid source commit");
  requireValue(typeof candidate.publishedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate.publishedAt)
    && new Date(candidate.publishedAt).toISOString() === candidate.publishedAt, "invalid publication date");
  requireValue(typeof candidate.notes === "string" && Buffer.byteLength(candidate.notes) <= 65536, "invalid release notes");
  const r = candidate.requirements;
  record(r, ["clientApiVersion", "minimumServerApiVersion", "capabilities", "cacheFormat", "cacheReadMin", "cacheReadMax", "cacheWrite"], "requirements");
  apiVersion(r.clientApiVersion);
  apiVersion(r.minimumServerApiVersion);
  capabilities(r.capabilities);
  requireValue(typeof r.cacheFormat === "string" && /^[a-zA-Z0-9:._-]{1,200}$/.test(r.cacheFormat), "invalid cache format");
  requireValue([r.cacheReadMin, r.cacheReadMax, r.cacheWrite].every((n) => Number.isSafeInteger(n) && n >= 1), "invalid cache schema");
  requireValue(r.cacheReadMin <= r.cacheWrite && r.cacheWrite <= r.cacheReadMax, "invalid cache range");
  record(candidate.variants, variants, "variants");
  const hashes = new Set();
  for (const channel of variants) {
    const variant = candidate.variants[channel];
    record(variant, ["identifier", "platform", "updater", "installer"], channel);
    requireValue(variant.identifier === channels[channel].identifier && variant.platform === platform, "wrong variant identity/platform");
    for (const kind of ["updater", "installer"]) {
      const asset = variant[kind];
      record(asset, ["url", "sha256", "signature"], `${channel} ${kind}`);
      const filename = kind === "updater" ? "AppSweet.app.tar.gz" : "AppSweet.dmg";
      const expected = kind === "installer" ? installerUrl(candidate.version, channel)
        : `${releaseOrigin}/desktop/builds/${candidate.version}/${channel}/${platform}/${filename}`;
      requireValue(asset.url === expected, "artifact must have exact immutable variant URL");
      requireValue(typeof asset.sha256 === "string" && digest.test(asset.sha256), "invalid artifact digest");
      requireValue(!hashes.has(asset.sha256), "variant artifacts must be distinct");
      hashes.add(asset.sha256);
      requireValue(typeof asset.signature === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(asset.signature)
        && asset.signature.length >= 80 && asset.signature.length <= 4096, "missing or malformed artifact signature");
    }
  }
  return candidate;
}

/** API and cache check independent of product release age or membership. */
export function compatibility(requirements, backend, cacheSchema, cacheFormat) {
  if (!backend) return "unknown";
  try {
    capabilities(backend.capabilities);
    if (compareApi(backend.minimumClientApiVersion, backend.serverApiVersion) > 0) return "unknown";
    if (compareApi(requirements.clientApiVersion, backend.minimumClientApiVersion) < 0) return "desktop-update-required";
    if (compareApi(requirements.clientApiVersion, backend.serverApiVersion) > 0
      || compareApi(requirements.minimumServerApiVersion, backend.serverApiVersion) > 0
      || requirements.capabilities.some((c) => !backend.capabilities.includes(c))) return "backend-update-required";
    if (cacheFormat !== requirements.cacheFormat || !Number.isSafeInteger(cacheSchema) || cacheSchema < requirements.cacheReadMin
      || cacheSchema > requirements.cacheReadMax || requirements.cacheWrite < cacheSchema) return "unsafe-cache-transition";
    return "compatible";
  } catch {
    return "unknown";
  }
}

/** Candidates must already belong to authenticated same-channel history. No network/cache of trust here. */
export function selectCompatibleCandidate({ candidates, channel, installedVersion, selectedOrigin, backend, cacheSchema, cacheFormat, now }) {
  requireValue(variants.includes(channel), "no distribution channel");
  requireValue(Number.isFinite(now), "invalid current time");
  parseCandidateVersion(installedVersion);
  if (!selectedOrigin || !backend || backend.origin !== selectedOrigin
    || !Number.isFinite(backend.observedAt) || backend.observedAt > now || now - backend.observedAt > 60000) return null;
  const validated = candidates.map(validateCandidate);
  requireValue(new Set(validated.map((c) => c.version)).size === validated.length, "duplicate candidate version");
  return validated.filter((c) => compareCandidateVersions(c.version, installedVersion) > 0
      && compatibility(c.requirements, backend, cacheSchema, cacheFormat) === "compatible")
    .sort((a, b) => compareCandidateVersions(b.version, a.version))[0] ?? null;
}

/** Used inside the publisher's CAS loop, after authentication of the current head. */
export function publicationDecision(channel, current, next) {
  requireValue(["alpha", "beta"].includes(channel), "channel publication is disabled");
  for (const entry of [current, next].filter(Boolean)) {
    record(entry, ["version", "sha256"], "membership");
    parseCandidateVersion(entry.version);
    requireValue(digest.test(entry.sha256), "invalid membership digest");
  }
  requireValue(next, "missing next candidate");
  if (!current) return "advance";
  const order = compareCandidateVersions(next.version, current.version);
  if (order === 0) {
    requireValue(next.sha256 === current.sha256, "immutable candidate conflict");
    return "unchanged";
  }
  return order < 0 ? "superseded" : "advance";
}

/** The inexpensive main guard uses this before scheduling any macOS build. */
export function desktopReleaseInput(path) {
  requireValue(typeof path === "string" && path.length > 0 && !path.startsWith("/")
    && !path.includes("\\") && !path.split("/").some((p) => ["", ".", ".."].includes(p)), "invalid repository path");
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /_tests?\.rs$/.test(path)
    || /(^|\/)(README|AGENTS|CHANGELOG)\.md$/i.test(path) || /\/(tests|__tests__|fixtures|e2e|\.artifacts)\//.test(path)) return false;
  return ["clients/apps/desktop/", "clients/shared/", "shared-rs/", "tools/release/desktop/"].some((p) => path.startsWith(p))
    || /^\.github\/workflows\/desktop-/.test(path)
    || /^tools\/(build-mac-app|release\/desktop-release-contract)/.test(path)
    || ["Cargo.toml", "Cargo.lock", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "rust-toolchain.toml",
      "tools/release/license-policy.json", "tools/release/keys/updater-public-keys.txt", "tools/release/publish-channel.mjs", "tools/release/channel-tree-contract.mjs"].includes(path)
    || path.startsWith("patches/") || path.startsWith(".cargo/");
}
