#!/usr/bin/env node
// Proves the updater package was signed by the key this bundle actually trusts.
//
// The build signs with whatever private key the protected environment holds, and the client
// verifies against the public key compiled into the bundle. Nothing else checks that those two are
// halves of the same pair — so a stale or independently rotated environment secret would produce a
// release that passes every other gate and that every installed client then refuses. This closes
// that gap before publication rather than after.
//
// Tauri uses minisign: a base64 file whose payload line is base64 of a two-byte algorithm tag, an
// 8-byte key id, and the key or signature bytes. `Ed` signs the message itself; `ED` — what Tauri
// actually emits — signs its BLAKE2b-512 digest.
import { readFile } from "node:fs/promises";
import { verify as edVerify, createHash, createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";

const PLACEHOLDER = "REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY";
// DER prefix for an Ed25519 SubjectPublicKeyInfo; Node needs a key object, minisign stores raw.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PURE = "Ed";
const PREHASHED = "ED";

function decodeContainer(field, expectedPayloadLength, label, allowedTags) {
  const decoded = Buffer.from(field.trim(), "base64").toString("utf8");
  const line = decoded
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("untrusted comment:") && !value.startsWith("trusted comment:"));
  if (!line) throw new Error(`${label} contains no payload line`);

  const body = Buffer.from(line, "base64");
  const tag = body.subarray(0, 2).toString();
  if (body.length < 10 || !allowedTags.includes(tag)) {
    throw new Error(`${label} is not an Ed25519 minisign container`);
  }
  const payload = body.subarray(10);
  if (payload.length !== expectedPayloadLength) {
    throw new Error(
      `${label} payload is ${payload.length} bytes, expected ${expectedPayloadLength}`,
    );
  }
  return { keyId: body.subarray(2, 10), payload, tag };
}

export function decodeMinisignPublicKey(field) {
  const { keyId, payload } = decodeContainer(field, 32, "updater public key", [PURE]);
  return { keyId, publicKey: payload };
}

export function decodeMinisignSignature(field) {
  const { keyId, payload, tag } = decodeContainer(field, 64, "updater signature", [
    PURE,
    PREHASHED,
  ]);
  return { keyId, signature: payload, prehashed: tag === PREHASHED };
}

export function verifyUpdaterSignature({ packageBytes, signatureFile, publicKeyField }) {
  if (!publicKeyField || publicKeyField.trim() === PLACEHOLDER) {
    return {
      valid: false,
      errors: [
        "the bundle still carries the placeholder updater public key; generate a real key before publishing",
      ],
    };
  }

  let embedded;
  let signature;
  try {
    embedded = decodeMinisignPublicKey(publicKeyField);
    signature = decodeMinisignSignature(signatureFile);
  } catch (error) {
    return { valid: false, errors: [error.message] };
  }

  if (!embedded.keyId.equals(signature.keyId)) {
    return {
      valid: false,
      errors: [
        `updater signature key id ${signature.keyId.toString("hex")} does not match the embedded key id ${embedded.keyId.toString("hex")}`,
      ],
    };
  }

  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, embedded.publicKey]),
    format: "der",
    type: "spki",
  });

  // Tauri emits prehashed signatures, which cover the BLAKE2b-512 digest rather than the bytes.
  const signed = signature.prehashed
    ? createHash("blake2b512").update(packageBytes).digest()
    : packageBytes;

  const verified = edVerify(null, signed, publicKey, signature.signature);
  return verified
    ? { valid: true }
    : {
        valid: false,
        errors: [
          "the updater signature does not verify against the embedded public key; every installed client would reject this update",
        ],
      };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    args[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  for (const name of ["package", "signature", "config"]) {
    if (!args[name]) {
      console.error(`missing required input: --${name}`);
      process.exit(1);
    }
  }

  const [packageBytes, signatureFile, config] = await Promise.all([
    readFile(args.package),
    readFile(args.signature, "utf8"),
    readFile(args.config, "utf8").then(JSON.parse),
  ]);

  const result = verifyUpdaterSignature({
    packageBytes,
    signatureFile,
    publicKeyField: config.plugins?.updater?.pubkey,
  });

  if (!result.valid) {
    console.error("updater signature verification failed:");
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("updater package verifies against the embedded public key");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
