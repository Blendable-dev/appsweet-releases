import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateBackendChannelDescriptor } from "./backend-channel-contract.mjs";

export function validateBetaChannelDescriptor(value, { acceptanceChannelId = null } = {}) {
  const result = validateBackendChannelDescriptor(value, { channel: "beta", acceptanceChannelId });
  return result.valid ? { valid: true } : result;
}

async function main(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  const result = validateBetaChannelDescriptor(value);
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
