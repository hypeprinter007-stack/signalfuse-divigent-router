#!/usr/bin/env node
// Derives the wallet address from DIVIGENT_WALLET_PRIVATE_KEY in .env
// and prints it. Optionally compares against an expected address.
// Never prints the private key itself.
//
// Usage:
//   node scripts/verify-key.mjs                     # print derived address
//   node scripts/verify-key.mjs 0xExpected…address  # compare to expected
//   DIVIGENT_WALLET_EXPECTED_ADDRESS=0x... node scripts/verify-key.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

let pk;
try {
  const text = readFileSync(envPath, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^\s+|\s+$/g, "");
    if (key !== "DIVIGENT_WALLET_PRIVATE_KEY") continue;
    let v = line.slice(eq + 1).replace(/^\s+|\s+$/g, "");
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    pk = v;
  }
} catch (e) {
  console.error(`Could not read ${envPath}: ${e.message}`);
  process.exit(1);
}

if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("DIVIGENT_WALLET_PRIVATE_KEY missing or not in 0x-prefixed 64-hex-char format");
  process.exit(1);
}

let derived;
try {
  derived = privateKeyToAccount(pk).address;
} catch (e) {
  console.error(`Key did not parse as a valid private key: ${e.message}`);
  process.exit(1);
}

const expectedRaw = process.argv[2] || process.env.DIVIGENT_WALLET_EXPECTED_ADDRESS;
console.log(`Derived address: ${derived}`);

if (!expectedRaw) {
  console.log("(no expected address provided — pass one as argv[1] or set DIVIGENT_WALLET_EXPECTED_ADDRESS to compare)");
  process.exit(0);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(expectedRaw)) {
  console.error(`Expected address malformed: ${expectedRaw}`);
  process.exit(1);
}

console.log(`Expected:        ${expectedRaw}`);
const match = derived.toLowerCase() === expectedRaw.toLowerCase();
console.log(match ? "OK — keys match." : "MISMATCH — this is NOT the key for the expected wallet.");
process.exit(match ? 0 : 2);
