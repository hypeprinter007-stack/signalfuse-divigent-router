#!/usr/bin/env node
// One-shot: pre-approve a generous USDC allowance from the wallet to the
// Divigent router. Removes the "deposit fails because approve == amount" retry
// pattern that depositIdle hits on its first sweep. Re-run any time allowance
// runs out (rarely, since the headroom is huge).
//
// Usage: node scripts/approve-router.mjs                # approves 10,000 USDC
//        node scripts/approve-router.mjs <amount_usdc>  # custom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createWalletClient, createPublicClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

const env = {};
for (const raw of readFileSync(envPath, "utf8").split("\n")) {
  const line = raw.replace(/^\s+|\s+$/g, "");
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq < 1) continue;
  const key = line.slice(0, eq).replace(/^\s+|\s+$/g, "");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
  let v = line.slice(eq + 1).replace(/^\s+|\s+$/g, "");
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  env[key] = v;
}

const pk = env.DIVIGENT_WALLET_PRIVATE_KEY;
const rpc = env.BASE_RPC_URL;
const ROUTER = env.DIVIGENT_ROUTER_ADDRESS || "0xE958A89c2CCa697d4896990685800cc1D5AF2A01";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

if (!pk || !pk.startsWith("0x")) {
  console.error("DIVIGENT_WALLET_PRIVATE_KEY missing");
  process.exit(1);
}
if (!rpc) {
  console.error("BASE_RPC_URL missing");
  process.exit(1);
}

const amountStr = process.argv[2] || "10000";
const amount = parseUnits(amountStr, 6);

const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });
const pub = createPublicClient({ chain: base, transport: http(rpc) });

console.log(`Approving ${amountStr} USDC from ${account.address} to router ${ROUTER}...`);

const hash = await wallet.writeContract({
  address: USDC,
  abi: [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
  functionName: "approve",
  args: [ROUTER, amount],
});

console.log(`tx: ${hash}`);
console.log("waiting for confirmation...");

const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`status: ${receipt.status}  block: ${receipt.blockNumber}`);

const newAllowance = await pub.readContract({
  address: USDC,
  abi: [{ name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }],
  functionName: "allowance",
  args: [account.address, ROUTER],
});

console.log(`new allowance: ${Number(newAllowance) / 1e6} USDC`);
