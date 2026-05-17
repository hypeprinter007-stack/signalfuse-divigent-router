import {
  Divigent,
  evmAddress,
  parseUsdc,
  type EvmAddress,
  type TxHash,
  type X402AttachHandle,
  type X402AutoDepositOptions,
  type X402IdleDepositOptions,
  type X402WrapConfig,
} from "@divigent/sdk";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { ChainClients } from "./wallet.js";
import type { X402Stack } from "./x402-client.js";
import { notifyBackend } from "./notify.js";

export interface DivigentHandle {
  client: Divigent;
  wallet: EvmAddress;
  /** Seller-side idle sweep — calls the SDK facade directly. */
  sweepIdle: () => Promise<TxHash | undefined>;
  /** Buyer-side x402 hookup. Optional; only needed if SignalFuse spends outbound x402. */
  attachX402: (stack: X402Stack) => {
    handle: X402AttachHandle;
    fetchWithYield: typeof fetch;
    detach: () => void;
  };
}

function sellerIdleOptions(wallet: EvmAddress): X402IdleDepositOptions {
  return {
    wallet,
    minIdleThreshold: parseUsdc(process.env.MIN_HOT_USDC ?? "20"),
    reserveRatio: Number(process.env.RESERVE_RATIO ?? 0.1),
    onIdleDeposit: async (ctx) => {
      await notifyBackend("/divigent/event/idle-deposit", {
        wallet: ctx.wallet,
        walletBalance: ctx.walletBalance.toString(),
        reserveFloor: ctx.reserveFloor.toString(),
        idleAmount: ctx.idleAmount.toString(),
        txHash: ctx.txHash,
        dedupeKey: ctx.dedupeKey,
        amount: ctx.idleAmount.toString(),
      });
    },
    onNonFatalError: async (ctx) => {
      await notifyBackend("/divigent/event/non-fatal-error", {
        phase: ctx.phase,
        error: ctx.error.message,
        recoverable: ctx.recoverable,
      });
    },
  };
}

export function initDivigent(chain: ChainClients): DivigentHandle {
  const client = Divigent.create({
    publicClient: chain.publicClient,
    walletClient: chain.walletClient,
    chain: chain.chain,
    addresses: chain.addresses,
  });

  const wallet = evmAddress(chain.address);

  const sweepIdle = () => client.depositIdle(sellerIdleOptions(wallet));

  const attachX402 = (stack: X402Stack) => {
    const wrapConfig: X402WrapConfig = {
      minIdleThreshold: parseUsdc(process.env.MIN_HOT_USDC ?? "20"),
      reserveRatio: Number(process.env.RESERVE_RATIO ?? 0.1),
      maxPaymentAmount: parseUsdc(process.env.MAX_PAYMENT_USDC ?? "100"),
      slippageBps: Number(process.env.WITHDRAW_SLIPPAGE_BPS ?? 50),
      onBeforePayment: async (ctx) => {
        await notifyBackend("/divigent/event/before-payment", { ctx });
      },
      onAfterPaymentCreation: async (ctx) => {
        await notifyBackend("/divigent/event/after-payment", { ctx });
      },
      onPaymentFailure: async (ctx) => {
        await notifyBackend("/divigent/event/payment-failure", { ctx });
      },
      onNonFatalError: async (ctx) => {
        await notifyBackend("/divigent/event/non-fatal-error", {
          phase: ctx.phase,
          error: ctx.error.message,
          recoverable: ctx.recoverable,
        });
      },
    };

    const handle = client.attachTo(stack.client, wrapConfig);

    const fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, stack.client);

    const autoDeposit: X402AutoDepositOptions = {
      onIdleDeposit: async (ctx) => {
        await notifyBackend("/divigent/event/idle-deposit", {
          wallet: ctx.wallet,
          walletBalance: ctx.walletBalance.toString(),
          reserveFloor: ctx.reserveFloor.toString(),
          idleAmount: ctx.idleAmount.toString(),
          txHash: ctx.txHash,
          dedupeKey: ctx.dedupeKey,
          amount: ctx.idleAmount.toString(),
        });
      },
      onNonFatalError: async (ctx) => {
        await notifyBackend("/divigent/event/non-fatal-error", {
          phase: ctx.phase,
          error: ctx.error.message,
          recoverable: ctx.recoverable,
        });
      },
    };

    const fetchWithYield = handle.wrapFetchWithYield(fetchWithPayment, stack.http, autoDeposit);

    return {
      handle,
      fetchWithYield,
      detach: handle.detach,
    };
  };

  return { client, wallet, sweepIdle, attachX402 };
}
