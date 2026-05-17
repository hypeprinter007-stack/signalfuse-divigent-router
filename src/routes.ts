import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { parseUsdc, formatUsdc } from "@divigent/sdk";
import type { DivigentHandle } from "./divigent.js";
import type { ChainClients } from "./wallet.js";
import { notifyBackend } from "./notify.js";

// USDC amounts are 6 decimals. Accept numeric strings or numbers; reject anything else.
const amountSchema = z.object({
  amount_usdc: z
    .union([
      z.string().regex(/^\d+(\.\d{1,6})?$/),
      z.number().positive().finite(),
    ])
    .transform((v) => String(v)),
});

function bearerEquals(presented: string, expected: string): boolean {
  // Length mismatch leak isn't a real concern (token length is config, not secret),
  // but timingSafeEqual requires equal-length buffers, so check length first.
  if (presented.length !== expected.length) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return timingSafeEqual(a, b);
}

function requireBearer(req: Request, res: Response, next: NextFunction) {
  const token = process.env.SIDECAR_API_TOKEN;
  if (!token) {
    return res.status(503).json({ error: "SIDECAR_API_TOKEN not configured" });
  }
  const header = req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !bearerEquals(presented, token)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function maxAllowedAmount(): bigint {
  return parseUsdc(process.env.MAX_PAYMENT_USDC ?? "100");
}

// Global token bucket for open RPC-consuming routes. Prevents quota DoS
// (e.g. Alchemy free-tier exhaustion) regardless of caller identity.
const RPC_TOKENS_PER_MIN = 60;
let rpcTokens = RPC_TOKENS_PER_MIN;
let rpcLastRefill = Date.now();

function rateLimitOpenRpc(_req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const elapsedMin = (now - rpcLastRefill) / 60_000;
  if (elapsedMin >= 1) {
    rpcTokens = Math.min(RPC_TOKENS_PER_MIN, rpcTokens + Math.floor(elapsedMin) * RPC_TOKENS_PER_MIN);
    rpcLastRefill = now;
  }
  if (rpcTokens <= 0) {
    return res.status(429).json({ error: "rate limit", retry_after_ms: 60_000 - (now - rpcLastRefill) });
  }
  rpcTokens--;
  next();
}

export function buildRoutes(
  divigent: DivigentHandle,
  chain: ChainClients,
): Router {
  const r = Router();

  // ── Open routes — read-only, safe to expose ──

  r.get("/health", (_req, res) => {
    res.json({ ok: true, wallet: divigent.wallet, chain: chain.chain });
  });

  r.get("/balance", rateLimitOpenRpc, async (_req, res, next) => {
    try {
      const [position, usdc] = await Promise.all([
        divigent.client.getPosition(divigent.wallet),
        divigent.client.usdcBalance(divigent.wallet),
      ]);
      res.json({ position, usdc });
    } catch (e) {
      next(e);
    }
  });

  r.get("/preview/withdraw", rateLimitOpenRpc, async (req, res, next) => {
    try {
      const desired = String(req.query.amount ?? "0");
      const result = await divigent.client.previewWithdrawNet(
        parseUsdc(desired),
        divigent.wallet,
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // ── Mutating routes — bearer auth + per-call amount cap ──

  r.post("/withdraw", requireBearer, async (req, res, next) => {
    try {
      const parsed = amountSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "bad amount_usdc" });
      }
      const desired = parseUsdc(parsed.data.amount_usdc);
      const cap = maxAllowedAmount();
      if (desired > cap) {
        return res.status(400).json({
          error: "amount exceeds MAX_PAYMENT_USDC",
          cap_usdc: formatUsdc(cap),
        });
      }
      const shares = await divigent.client.previewWithdrawNet(desired, divigent.wallet);
      const result = await divigent.client.withdrawAndWait({
        shares,
        wallet: divigent.wallet,
        slippageBps: Number(process.env.WITHDRAW_SLIPPAGE_BPS ?? 50),
      });
      void notifyBackend("/divigent/event/manual-withdraw", {
        txHash: result.txHash,
        amount: result.usdcReturned.toString(),
        wallet: divigent.wallet,
        sharesBurned: shares.toString(),
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  r.post("/deposit", requireBearer, async (req, res, next) => {
    try {
      const parsed = amountSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "bad amount_usdc" });
      }
      const amount = parseUsdc(parsed.data.amount_usdc);
      const cap = maxAllowedAmount();
      if (amount > cap) {
        return res.status(400).json({
          error: "amount exceeds MAX_PAYMENT_USDC",
          cap_usdc: formatUsdc(cap),
        });
      }
      const hot = await divigent.client.usdcBalance(divigent.wallet);
      if (amount > hot) {
        return res.status(400).json({
          error: "amount exceeds wallet USDC balance",
          balance_usdc: formatUsdc(hot),
        });
      }
      const allowance = await divigent.client.usdcAllowance(divigent.wallet);
      let approveTx: string | undefined;
      if (allowance < amount) {
        approveTx = await divigent.client.approveUsdc(amount);
      }
      const result = await divigent.client.depositAndWait({
        amount,
        wallet: divigent.wallet,
      });
      void notifyBackend("/divigent/event/manual-deposit", {
        txHash: result.txHash,
        amount: amount.toString(),
        wallet: divigent.wallet,
        sharesMinted: result.sharesMinted.toString(),
        approveTx,
      });
      res.json({ ...result, approveTx });
    } catch (e) {
      next(e);
    }
  });

  r.post("/sweep", requireBearer, async (_req, res, next) => {
    try {
      const txHash = await divigent.sweepIdle();
      res.json({ txHash: txHash ?? null, swept: txHash !== undefined });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
