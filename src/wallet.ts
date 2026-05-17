import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { ContractAddresses, DivigentChain } from "@divigent/sdk";
import { evmAddress } from "@divigent/sdk";

export interface ChainClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
  address: `0x${string}`;
  chain: DivigentChain;
  chainId: number;
  addresses?: ContractAddresses;
}

export function loadChainClients(): ChainClients {
  const pk = process.env.DIVIGENT_WALLET_PRIVATE_KEY;
  const chainName = (process.env.DIVIGENT_CHAIN ?? "base") as DivigentChain;
  const rpc = process.env.BASE_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL;

  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      "DIVIGENT_WALLET_PRIVATE_KEY missing or not in 0x-prefixed 64-hex-char format",
    );
  }
  if (!rpc) {
    throw new Error("BASE_RPC_URL missing");
  }
  if (chainName !== "base" && chainName !== "base-sepolia") {
    throw new Error(`Unsupported DIVIGENT_CHAIN '${chainName}'. Use 'base' or 'base-sepolia'.`);
  }

  const viemChain = chainName === "base" ? base : baseSepolia;
  const account = privateKeyToAccount(pk as `0x${string}`);
  const addresses = loadAddressOverrides();

  return {
    publicClient: createPublicClient({ chain: viemChain, transport: http(rpc) }) as PublicClient,
    walletClient: createWalletClient({ account, chain: viemChain, transport: http(rpc) }),
    account,
    address: account.address,
    chain: chainName,
    chainId: viemChain.id,
    addresses,
  };
}

// As of @divigent/sdk@1.0.0, mainnet (base) router/oracle/feeCollector/dvUsdc
// addresses ship inside the SDK's CHAINS registry, so overrides are no longer
// required. Kept here only for private/test deployments.
function loadAddressOverrides(): ContractAddresses | undefined {
  const router = process.env.DIVIGENT_ROUTER_ADDRESS;
  const oracle = process.env.DIVIGENT_ORACLE_ADDRESS;
  const feeCollector = process.env.DIVIGENT_FEE_COLLECTOR_ADDRESS;
  const dvUsdc = process.env.DIVIGENT_DVUSDC_ADDRESS;

  if (!router || !oracle || !feeCollector || !dvUsdc) return undefined;

  return {
    router: evmAddress(router),
    oracle: evmAddress(oracle),
    feeCollector: evmAddress(feeCollector),
    dvUsdc: evmAddress(dvUsdc),
    usdc: evmAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    aavePool: evmAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"),
    aToken: evmAddress("0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB"),
    steakhouseUSDCPrimeVault: evmAddress("0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183"),
  };
}
