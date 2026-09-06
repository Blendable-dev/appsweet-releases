import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseBuildVersion } from "./build-identity.mjs";

async function loadSchema(name) {
  try {
    return JSON.parse(await readFile(new URL(`../../deploy/self-host/${name}`, import.meta.url), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // The signed backend archive places the verifier and its schemas beside each other.
    return JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
  }
}
const buildSchema = await loadSchema("build.schema.json");

const supportedSchemaKeywords = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "const",
  "contains",
  "else",
  "enum",
  "format",
  "if",
  "items",
  "minItems",
  "minimum",
  "pattern",
  "properties",
  "required",
  "title",
  "then",
  "type",
  "uniqueItems",
]);

export function assertSupportedSchemaVocabulary(schema, path = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${path} must be a JSON Schema object`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!supportedSchemaKeywords.has(keyword)) {
      throw new Error(`unsupported JSON Schema keyword at ${path}: ${keyword}`);
    }
  }
  for (const [name, child] of Object.entries(schema.$defs ?? {})) {
    assertSupportedSchemaVocabulary(child, `${path}.$defs.${name}`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertSupportedSchemaVocabulary(child, `${path}.properties.${name}`);
  }
  if (schema.items) {
    assertSupportedSchemaVocabulary(schema.items, `${path}.items`);
  }
  if (schema.contains) {
    assertSupportedSchemaVocabulary(schema.contains, `${path}.contains`);
  }
  for (const [index, child] of (schema.allOf ?? []).entries()) {
    assertSupportedSchemaVocabulary(child, `${path}.allOf[${index}]`);
  }
  for (const keyword of ["if", "then", "else"]) {
    if (schema[keyword]) {
      assertSupportedSchemaVocabulary(schema[keyword], `${path}.${keyword}`);
    }
  }
}

assertSupportedSchemaVocabulary(buildSchema);

function resolveReference(reference, rootSchema) {
  if (!reference.startsWith("#/")) {
    throw new Error(`unsupported schema reference: ${reference}`);
  }
  const resolved = reference
    .slice(2)
    .split("/")
    .reduce(
      (value, segment) =>
        value?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
      rootSchema,
    );
  if (!resolved) throw new Error(`unresolved schema reference: ${reference}`);
  return resolved;
}

function matchesType(value, type) {
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function isRfc3339DateTime(value) {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    Number.isFinite(Date.parse(value)) &&
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
}

function validateSchema(value, schema, path, errors, rootSchema) {
  if (schema.$ref) {
    validateSchema(
      value,
      resolveReference(schema.$ref, rootSchema),
      path,
      errors,
      rootSchema,
    );
  }

  if (schema.allOf) {
    for (const child of schema.allOf) {
      validateSchema(value, child, path, errors, rootSchema);
    }
  }

  if (schema.if) {
    const conditionErrors = [];
    validateSchema(value, schema.if, path, conditionErrors, rootSchema);
    const branch = conditionErrors.length === 0 ? schema.then : schema.else;
    if (branch) validateSchema(value, branch, path, errors, rootSchema);
  }

  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be a ${schema.type}`);
    return;
  }
  if (
    typeof value === "number" &&
    schema.minimum !== undefined &&
    value < schema.minimum
  ) {
    errors.push(`${path} must be at least ${schema.minimum}`);
  }

  if (matchesType(value, "object")) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(`${path}.${required} is required`);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateSchema(value[key], child, `${path}.${key}`, errors, rootSchema);
      }
    }
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} does not match the required pattern`);
    }
    if (schema.format === "date-time" && !isRfc3339DateTime(value)) {
      errors.push(`${path} must be an RFC3339 date-time`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      errors.push(`${path} items must be unique`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateSchema(
          item,
          schema.items,
          `${path}[${index}]`,
          errors,
          rootSchema,
        ),
      );
    }
    if (schema.contains) {
      const containsMatch = value.some((item) => {
        const candidateErrors = [];
        validateSchema(
          item,
          schema.contains,
          path,
          candidateErrors,
          rootSchema,
        );
        return candidateErrors.length === 0;
      });
      if (!containsMatch) errors.push(`${path} does not contain a required item`);
    }
  }
}

export function validateValueAgainstSchema(value, schema) {
  assertSupportedSchemaVocabulary(schema);
  const errors = [];
  validateSchema(value, schema, "value", errors, schema);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export function validateReleaseManifest(value) {
  const schemaResult = validateValueAgainstSchema(value, buildSchema);
  const errors = schemaResult.valid ? [] : schemaResult.errors;
  if (!matchesType(value, "object")) {
    return { valid: false, errors };
  }
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  if (value.release?.tag !== `backend-v${value.release?.version}`) {
    errors.push("release.tag must equal backend-v<release.version>");
  }

  const backend = value.images?.backend;
  if (
    typeof backend?.reference !== "string" ||
    !backend.reference.includes(`:${value.release?.version}@sha256:`)
  ) {
    errors.push("images.backend.reference must be a versioned image reference");
  }
  if (!backend?.reference?.endsWith(`@${backend?.digest}`)) {
    errors.push("images.backend reference digest must match images.backend.digest");
  }

  for (const [name, image] of Object.entries(value.images ?? {})) {
    if (!image?.reference?.endsWith(`@${image?.digest}`)) {
      errors.push(`images.${name} reference digest must match images.${name}.digest`);
    }
  }

  if (value.signing.publicKey.file !== "backend-beta.pub") {
    errors.push("signing.publicKey.file must equal backend-beta.pub");
  }
  if (value.signing.keyId !== `sha256:${value.signing.publicKey.sha256}`) {
    errors.push("signing.keyId must equal sha256:<signing.publicKey.sha256>");
  }

  const version = value.release?.version;
  for (const boundVersion of [version, value.compatibility.minimumUpgradeFrom]) {
    try { parseBuildVersion(boundVersion); } catch (error) { errors.push(error.message); }
  }

  if (
    value.artifacts?.backendArchive?.file !==
    `appsweet-backend-${version}.tar.gz`
  ) {
    errors.push(
      "backend archive file must equal appsweet-backend-<release.version>.tar.gz",
    );
  }

  const deploymentArtifacts = {
    deploymentBundle: `appsweet-self-host-${version}.tar.gz`,
    installerBootstrap: `appsweet-install-${version}.sh`,
    migrationUtility: `appsweet-migrate-${version}.tar.gz`,
    configurationUtility: `appsweet-configure-${version}.tar.gz`,
    verificationUtility: `appsweet-verify-${version}.tar.gz`,
    setupUtility: `appsweet-setup-${version}.tar.gz`,
  };

  {
    if (!/^[a-f0-9]{64}$/.test(value.deploymentDefinitionSha256 ?? "")) {
      errors.push(
        "installable build requires deploymentDefinitionSha256",
      );
    }
    const desktop = value.desktop;
    let desktopDownload;
    try {
      desktopDownload = new URL(desktop?.downloadUrl);
    } catch {
      desktopDownload = null;
    }
    if (
      !desktop ||
      desktop.architecture !== "aarch64" ||
      !desktop.version?.includes("-") ||
      !desktopDownload ||
      desktopDownload.protocol !== "https:" ||
      !desktopDownload.hostname ||
      desktopDownload.username ||
      desktopDownload.password ||
      desktopDownload.search ||
      desktopDownload.hash ||
      desktopDownload.pathname.toLowerCase().split("/").includes("latest") ||
      !desktopDownload.pathname.includes(desktop.version) ||
      !/(?:aarch64|arm64|apple-silicon)/i.test(desktopDownload.pathname)
    ) {
      errors.push(
        "installable build requires immutable Apple Silicon desktop release metadata",
      );
    }
    for (const name of [
      "backend",
      "postgres",
      "zitadel",
      "zitadelLogin",
      "garage",
      "caddy",
    ]) {
      if (!Object.hasOwn(value.images, name)) {
        errors.push(`installable build requires images.${name}`);
      }
    }

    for (const [name, expectedFile] of Object.entries(deploymentArtifacts)) {
      if (!Object.hasOwn(value.artifacts, name)) {
        errors.push(`installable build requires artifacts.${name}`);
      } else if (value.artifacts[name]?.file !== expectedFile) {
        errors.push(
          `artifacts.${name}.file must equal ${expectedFile} for an installable build`,
        );
      }
    }

    const runtime = value.compatibility.runtime;
    if (!runtime) {
      errors.push("installable build requires compatibility.runtime");
    } else if (
      runtime.dockerEngine !== "24.0.0" ||
      runtime.composeMajor !== 2 ||
      runtime.dokploy?.minimum !== "0.29.5" ||
      runtime.dokploy?.tested !== "0.29.5"
    ) {
      errors.push("installable build requires the declared runtime compatibility");
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

async function main(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  const result = validateReleaseManifest(value);
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
