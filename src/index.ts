import express from "express";
import { chmodSync } from "node:fs";
import { loadChainClients } from "./wallet.js";
import { initDivigent } from "./divigent.js";
import { createX402Stack } from "./x402-client.js";
import { buildRoutes } from "./routes.js";
import { notifyBackend } from "./notify.js";

// SDK returns USDC amounts as bigint. Express's res.json() calls JSON.stringify()
// which can't handle bigint by default; this is the canonical workaround.
// Mutating the global prototype is acceptable here because this is the sole
// owner of the process and no imported library depends on the default throw.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

// Fail-fast if the backend URL would send our bearer token over plaintext HTTP.
// Localhost is allowed for dev / smoke testing.
{
  const backendUrl = process.env.BACKEND_URL;
  if (backendUrl) {
    const isHttps = backendUrl.startsWith("https://");
    const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(backendUrl);
    if (!isHttps && !isLocal) {
      console.error(`[router] refusing to start: BACKEND_URL must be https:// (got ${backendUrl})`);
      process.exit(1);
    }
  }
}

// Tighten log file perms — launchd creates the log with the user's umask
// (typically 022 = world-readable). We re-chmod to 600 once we own the fd.
{
  const stdoutPath = process.env.LOG_PATH;
  if (stdoutPath) {
    try {
      chmodSync(stdoutPath, 0o600);
    } catch {
      // Non-fatal — log file may not exist yet, or perm change may be refused.
    }
  }
}

async function main() {
  const chain = loadChainClients();
  const divigent = initDivigent(chain);

  const initTx = await divigent.client.ensureInitializedAndWait();
  console.log(
    initTx
      ? `[router] wallet initialized on Divigent router: ${initTx}`
      : "[router] wallet already initialized on Divigent router",
  );

  // Buyer-side x402 attach is opt-in. SignalFuse is seller-side; the buyer
  // stack only matters if you intend to make outbound x402 payments through
  // this wallet (Divigent recall flow). Off by default.
  let detachBuyer: (() => void) | undefined;
  if (process.env.BUYER_SIDE_X402 === "true") {
    const x402Stack = createX402Stack(chain);
    const attached = divigent.attachX402(x402Stack);
    detachBuyer = attached.detach;
    console.log(`[router] buyer-side x402 attached, network=${x402Stack.network}`);
  }

  const app = express();
  app.disable("x-powered-by"); // don't broadcast framework
  app.use(express.json({ limit: "32kb" }));
  app.use("/", buildRoutes(divigent, chain));

  // Generic error handler — does NOT surface SDK error bodies to the caller
  // because SDK errors sometimes embed wallet/amount info. Full detail is
  // still logged for the operator.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[router] route error:", err);
    res.status(500).json({ error: "internal error" });
  });

  const host = process.env.SIDECAR_HOST ?? "127.0.0.1";
  const port = Number(process.env.SIDECAR_PORT ?? 7000);
  const server = app.listen(port, host, () => {
    console.log(`[router] chain=${chain.chain} wallet=${chain.address} listening http://${host}:${port}`);
  });

  // Sweep ticker — overlap guard prevents a second sweep firing while the
  // previous one is still broadcasting (nonce safety on slow RPCs).
  let sweepBusy = false;
  const sweepIntervalMs = Number(process.env.SWEEP_INTERVAL_MS ?? 300_000);
  let sweepTimer: NodeJS.Timeout | undefined;
  if (sweepIntervalMs > 0) {
    console.log(`[router] sweep ticker every ${sweepIntervalMs}ms`);
    sweepTimer = setInterval(() => {
      if (sweepBusy) {
        console.warn("[router] sweep tick skipped — previous still in flight");
        return;
      }
      sweepBusy = true;
      divigent
        .sweepIdle()
        .then((txHash) => {
          if (txHash) console.log(`[router] auto-sweep deposited: ${txHash}`);
        })
        .catch((err) => {
          console.error("[router] auto-sweep failed", err);
          void notifyBackend("/divigent/event/sweep-failure", { error: String(err) });
        })
        .finally(() => {
          sweepBusy = false;
        });
    }, sweepIntervalMs);
    sweepTimer.unref();
  }

  // Snapshot ticker — awaited first push then guarded interval.
  let snapshotBusy = false;
  const pushSnapshot = async () => {
    if (snapshotBusy) {
      console.warn("[router] snapshot tick skipped — previous still in flight");
      return;
    }
    snapshotBusy = true;
    try {
      const [position, hot] = await Promise.all([
        divigent.client.getPosition(divigent.wallet),
        divigent.client.usdcBalance(divigent.wallet),
      ]);
      await notifyBackend("/divigent/event/snapshot", {
        hot_usdc_atomic: hot.toString(),
        position: {
          principal: position.depositedUSDC.toString(),
          value: position.currentValue.toString(),
          yield: position.accruedYield.toString(),
        },
        wallet: divigent.wallet,
        chain: chain.chain,
      });
    } catch (err) {
      console.error("[router] snapshot failed", err);
    } finally {
      snapshotBusy = false;
    }
  };
  const snapshotIntervalMs = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 60_000);
  let snapshotTimer: NodeJS.Timeout | undefined;
  if (snapshotIntervalMs > 0) {
    console.log(`[router] snapshot ticker every ${snapshotIntervalMs}ms`);
    await pushSnapshot();
    snapshotTimer = setInterval(pushSnapshot, snapshotIntervalMs);
    snapshotTimer.unref();
  }

  // Graceful shutdown — stop accepting work, drain in-flight tickers, then exit.
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`[router] ${signal} received — graceful shutdown`);
    if (sweepTimer) clearInterval(sweepTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    const drainStart = Date.now();
    while ((sweepBusy || snapshotBusy) && Date.now() - drainStart < 30_000) {
      await new Promise((r) => setTimeout(r, 250));
    }
    detachBuyer?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[router] fatal", e);
  process.exit(1);
});
