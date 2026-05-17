# signalfuse-divigent-router

> Seller-side sidecar for routing idle x402 USDC into [Divigent](https://divigent.com) yield on Base mainnet. Built by [SignalFuse](https://signalfuse.co) for the Divigent protocol.

[![Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-43853d.svg)](.nvmrc)
[![Divigent SDK](https://img.shields.io/badge/%40divigent%2Fsdk-1.0.2-c9a96e.svg)](https://www.npmjs.com/package/@divigent/sdk)

A small, hardened TypeScript service that sits next to your x402 resource
server and continuously sweeps idle wallet USDC above a configured reserve
floor into Divigent's yield router (Aave + Steakhouse USDC Prime).

Designed for the common case where your resource server isn't TypeScript
(ours is Python / FastAPI), so the canonical
`divigent.attachToResourceServer()` pattern doesn't apply. This sidecar uses
the SDK's `depositIdle()` facade directly with a sweep ticker, plus a few
operational details we learned the hard way.

---

## Why this exists

Divigent's TS SDK assumes single-process integrations
(`attachToResourceServer(resourceServer, config)`). Most production sellers
have a separate process holding the wallet keys, often in a different
language. This sidecar wraps the right SDK calls into a tiny HTTP service
that:

- Auto-sweeps idle USDC into dvUSDC on a configurable interval
- Pushes wallet + position snapshots to your backend for dashboards
- Lets you manually `/deposit`, `/withdraw`, `/sweep`, and read `/balance`
- Handles the one-time wallet initialization and USDC pre-approval
- Survives a `launchd` / `systemd` restart cleanly

It's also a record of the integration gotchas. If you're rolling your own,
read [`docs/lessons.md`](docs/lessons.md) first.

---

## Architecture

```
                    ┌───────────────────────────────┐
   x402 receipts    │      Your seller wallet       │
   (USDC on Base) ──┤  0xYour…wallet                ├──┐
                    └───────────────────────────────┘  │
                                                       │
                       sweep ticker (5 min)            │
                       snapshot ticker (60 s)          │
                                                       │
       ┌───────────────────────────────────────────────┴───────────┐
       │                  this sidecar                              │
       │              localhost:7100                                │
       │                                                            │
       │   POST /deposit      auth + cap + balance check            │
       │   POST /withdraw     auth + cap + slippage                 │
       │   POST /sweep        auth — fires depositIdle()            │
       │   GET  /balance      open, RPC rate-limited                │
       │   GET  /preview/withdraw  open, RPC rate-limited           │
       │   GET  /health       open                                  │
       └────┬────────────────────────────────────────────┬─────────┘
            │                                            │
            ▼                                            ▼
     Divigent router                              Your backend
     (Base mainnet)                               (FastAPI / Express / …)
     0xE958…2A01                                  receives lifecycle events
                                                  for dashboards + alerting
```

---

## Quickstart

Requirements: Node 20+, a Base mainnet RPC URL (Alchemy / QuickNode / Coinbase
Developer Platform), and the private key for your x402 receiving wallet.

```bash
git clone https://github.com/hypeprinter007-stack/signalfuse-divigent-router
cd signalfuse-divigent-router
npm install

cp .env.example .env
chmod 600 .env
# Edit .env — set DIVIGENT_WALLET_PRIVATE_KEY, BASE_RPC_URL, SIDECAR_API_TOKEN
$EDITOR .env

# Verify the key derives to the wallet you expect
node scripts/verify-key.mjs

# One-time pre-approval (10k USDC) so depositIdle() runs as single-tx
node scripts/approve-router.mjs 10000

# Run it
npm run dev
```

You should see:

```
[router] wallet already initialized on Divigent router
[router] sweep ticker every 300000ms
[router] snapshot ticker every 60000ms
[router] chain=base wallet=0x… listening http://127.0.0.1:7100
```

The first boot auto-runs `ensureInitializedAndWait()` to register the wallet
on Divigent's router (one-time on-chain tx; idempotent on subsequent boots).

---

## Configuration

All values come from `.env` (loaded by `tsx --env-file=.env` and
`node --env-file=.env`). Required values have no defaults — boot fails fast.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `DIVIGENT_WALLET_PRIVATE_KEY` | — | yes | 0x-prefixed 64 hex chars. Private key of the wallet that owns the USDC. |
| `BASE_RPC_URL` | `https://mainnet.base.org` | recommended | Paid RPC endpoint. The public Base RPC will rate-limit you under sustained tickers. |
| `DIVIGENT_CHAIN` | `base` | no | `base` (mainnet) or `base-sepolia` (testnet). |
| `SIDECAR_API_TOKEN` | — | yes | Bearer token for `/deposit`, `/withdraw`, `/sweep`. Generate with `openssl rand -hex 32`. |
| `SIDECAR_HOST` | `127.0.0.1` | no | Listen address. Keep loopback unless you've got a real reason. |
| `SIDECAR_PORT` | `7100` | no | Listen port. Port 7000 is taken by macOS Control Center. |
| `MIN_HOT_USDC` | `5` | no | Reserve USDC kept liquid in the wallet (NOT swept). |
| `RESERVE_RATIO` | `0.1` | no | EMA reserve ratio for the liquid payment buffer. |
| `MAX_PAYMENT_USDC` | `100` | no | Per-call cap on `/deposit` and `/withdraw` amounts. |
| `WITHDRAW_SLIPPAGE_BPS` | `50` | no | Slippage tolerance on withdraws (basis points). |
| `SWEEP_INTERVAL_MS` | `300000` | no | Auto-sweep cadence. Set `0` to disable. |
| `SNAPSHOT_INTERVAL_MS` | `60000` | no | Snapshot push cadence. Set `0` to disable. |
| `BACKEND_URL` | — | no | URL of your dashboard/observability backend. Sidecar POSTs lifecycle events here. |
| `BACKEND_TOKEN` | — | no | Bearer token added to outbound notify calls. |
| `BUYER_SIDE_X402` | `false` | no | Set `true` to wire the buyer-side x402 attach (for outbound x402 spending). |
| `LOG_PATH` | — | no | If set, sidecar `chmod 600`s the file on boot. Used by the launchd plist. |

---

## HTTP API

### `GET /health`
Open. Returns `{ ok: true, wallet, chain }`.

### `GET /balance`
Open (rate-limited globally to 60/min). Returns live wallet USDC + Divigent position.

```json
{
  "position": {
    "depositedUSDC": "100314141",
    "currentValue": "100315103",
    "accruedYield": "962"
  },
  "usdc": "9000001"
}
```

All amounts are USDC atomic units (6 decimals) as JSON strings (preserved precision; converted from bigint).

### `GET /preview/withdraw?amount=<usdc>`
Open (rate-limited). Returns the number of dvUSDC shares needed to receive `amount` USDC net.

### `POST /deposit` *(auth required)*
Body: `{ "amount_usdc": "10" | 10 }`. Caps at `MAX_PAYMENT_USDC` and wallet balance. Returns deposit tx hash + dvUSDC shares minted.

### `POST /withdraw` *(auth required)*
Body: `{ "amount_usdc": "5" }`. Internally converts USDC → shares via `previewWithdrawNet`. Returns withdraw tx hash + USDC actually returned.

### `POST /sweep` *(auth required)*
No body. Fires `depositIdle()` immediately. Returns `{ txHash, swept: true | false }`. Returns `swept: false` if wallet idle was below `MIN_DEPOSIT` ($10 on Divigent mainnet).

**Auth:** mutating routes require `Authorization: Bearer <SIDECAR_API_TOKEN>`. Compared with `crypto.timingSafeEqual`.

---

## Backend event contract

If you set `BACKEND_URL`, the sidecar POSTs lifecycle events to your backend
with `Authorization: Bearer ${BACKEND_TOKEN}` (if `BACKEND_TOKEN` set).

Paths and bodies:

| Path | Trigger | Body shape |
|---|---|---|
| `/divigent/event/snapshot` | every `SNAPSHOT_INTERVAL_MS` | `{ hot_usdc_atomic, position: { principal, value, yield }, wallet, chain }` (all amounts as string atomic units) |
| `/divigent/event/idle-deposit` | successful auto-sweep | `{ wallet, walletBalance, reserveFloor, idleAmount, txHash, dedupeKey, amount }` |
| `/divigent/event/manual-deposit` | manual `POST /deposit` succeeded | `{ txHash, amount, wallet, sharesMinted, approveTx }` |
| `/divigent/event/manual-withdraw` | manual `POST /withdraw` succeeded | `{ txHash, amount, wallet, sharesBurned }` |
| `/divigent/event/sweep-failure` | auto-sweep threw | `{ error }` |
| `/divigent/event/before-payment` | (buyer-side x402 only) | `{ ctx }` |
| `/divigent/event/after-payment` | (buyer-side x402 only) | `{ ctx }` |
| `/divigent/event/payment-failure` | (buyer-side x402 only) | `{ ctx }` |
| `/divigent/event/non-fatal-error` | SDK soft errors | `{ phase, error, recoverable }` |

All calls are fire-and-forget — sidecar never blocks on backend response. 5-second `AbortSignal.timeout`. Failures are logged but never propagate.

---

## Production checklist

Things baked into this sidecar from running it on mainnet for SignalFuse.
Read them before deploying:

- **Pre-approve a generous USDC allowance to the Divigent router.** Without this, `depositIdle()` first emits a `sweep-failure` event each cycle before retrying successfully. `scripts/approve-router.mjs 10000` handles it as a one-time tx. Divigent confirmed this is the recommended pattern for seller-side sidecars in [SDK 1.0.2](https://www.npmjs.com/package/@divigent/sdk).
- **Bearer auth on mutating routes.** Don't rely on localhost binding alone. Local malware can reach `127.0.0.1`.
- **Cap deposit/withdraw amounts.** A typo (`"100000"` instead of `"100"`) shouldn't be able to empty the wallet. The included `MAX_PAYMENT_USDC` check returns 400 before any SDK call.
- **Overlap guards on tickers.** Sweep + snapshot have `busy` flags so a slow RPC can't trigger a second concurrent call. Important for nonce safety.
- **Graceful shutdown.** SIGTERM/SIGINT drains in-flight work for up to 30s before exiting.
- **timingSafeEqual for the bearer.** Hand-rolled XOR comparisons leak timing info.
- **Tighten log file perms.** Plist sets `LOG_PATH` and the sidecar `chmod 600`s it on boot. macOS default umask leaves logs world-readable.
- **Time Machine exclusion for `.env`.** `sudo tmutil addexclusion ~/path/to/.env`.

### Security audit

A 15-finding security audit was performed against this codebase pre-launch
covering: secret handling, auth + rate limits, input validation, response
headers (HSTS / CSP / X-Frame / X-Content-Type / Referrer / Permissions-Policy),
log file permissions, dependency tree (`npm audit` clean), CORS surface,
timing-safe comparisons, and supply chain. Findings were addressed before
the initial public release. Accepted constraints:

- Wallet private key lives in Node process memory — architectural mitigation
  requires a hardware wallet or remote signer.
- `esbuild`'s `postinstall` downloads a native binary (industry standard;
  mitigated by committed lockfile + `npm ci` in CI).

---

## Development

```bash
npm run dev        # tsx watch — auto-restart on file change
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
npm run start      # node --env-file=.env dist/index.js
```

CI (GitHub Actions) runs `npm ci && npm run typecheck && npm audit --audit-level=moderate` on every push.

---

## Deploying on macOS via launchd

Sample plist in [`examples/com.example.divigent-router.plist`](examples/com.example.divigent-router.plist).
Loads with:

```bash
cp examples/com.example.divigent-router.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.example.divigent-router.plist
```

`KeepAlive: true` + `ThrottleInterval: 30` keeps the process alive across
crashes without crashloop spam.

---

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Acknowledgements

- The [Divigent](https://divigent.com) protocol and SDK team for the
  on-chain plumbing and patch responsiveness during integration.
- The [x402](https://x402.org) Foundation for the payment standard.
- [viem](https://viem.sh) for the cleanest EVM TypeScript surface in the
  ecosystem.

Built by [SignalFuse](https://signalfuse.co). Issues + PRs welcome.
