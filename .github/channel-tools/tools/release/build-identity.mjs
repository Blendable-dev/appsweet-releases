const corePattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const buildPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-build\.([1-9][0-9]*)$/;
const maximum = BigInt(Number.MAX_SAFE_INTEGER);

function safeInteger(value) {
  const integer = BigInt(value);
  if (integer > maximum) throw new Error("build identity exceeds the supported integer range");
  return Number(integer);
}

/** A build version identifies immutable content, never its distribution channel. */
export function parseBuildVersion(version) {
  const match = typeof version === "string" && buildPattern.exec(version);
  if (!match) throw new Error("build version must be <core>-build.<positive sequence>");
  const [, major, minor, patch, sequence] = match;
  return { core: `${major}.${minor}.${patch}`, sequence: safeInteger(sequence),
    parts: [major, minor, patch].map(safeInteger) };
}

export function buildVersion(core, sequence) {
  if (!corePattern.test(core) || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("a reviewed core and positive safe integer sequence are required");
  }
  const version = `${core}-build.${sequence}`;
  parseBuildVersion(version);
  return version;
}

export function compareBuildVersions(left, right) {
  const a = parseBuildVersion(left);
  const b = parseBuildVersion(right);
  const x = [...a.parts, a.sequence];
  const y = [...b.parts, b.sequence];
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Binds a durable allocation to all release inputs; the publisher persists it before building. */
export function allocateBuild({ core, sequence, commitSha, inputsSha256 }, existing = null) {
  if (!/^[a-f0-9]{40}$/.test(commitSha) || !/^[a-f0-9]{64}$/.test(inputsSha256)) {
    throw new Error("allocation requires an exact source commit and release-input SHA-256");
  }
  const allocation = { schemaVersion: 1, version: buildVersion(core, sequence), commitSha, inputsSha256 };
  if (existing !== null && (Object.keys(existing).length !== 4 ||
      Object.entries(allocation).some(([key, value]) => existing[key] !== value))) {
    throw new Error("immutable build allocation conflicts with its recorded inputs");
  }
  return allocation;
}
