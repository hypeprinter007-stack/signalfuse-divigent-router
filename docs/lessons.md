# Integration lessons

A running tally of the gotchas we hit bringing this sidecar up against
Divigent on Base mainnet, in the hope that the next integrator skips them.

## SDK behavior

### `MIN_DEPOSIT` is $10 on-chain, errors are opaque
Divigent's router enforces a hard minimum at the contract level. As of
SDK 1.0.2 it surfaces as `Divigent contract revert: InvalidAmount()`. Read
it before smoke testing:

```ts
await publicClient.readContract({
  address: '0xE958A89c2CCa697d4896990685800cc1D5AF2A01',
  abi: [{ name: 'MIN_DEPOSIT', type: 'function', stateMutability: 'view',
         inputs: [], outputs: [{ type: 'uint256' }] }],
  functionName: 'MIN_DEPOSIT',
}); // → 10000000n  ($10)
```

A typed `MinDepositError` is planned for v1.1.

### `depositIdle` silently no-ops below the threshold
Returns `undefined` whether the sweep landed below `MIN_DEPOSIT` or whether
there was simply nothing above the reserve floor. Indistinguishable for
dashboards. v1.1 will add a typed result.

### Wallet must be initialized once before any deposit
`ensureInitializedAndWait()` on boot is idempotent (returns `undefined`
when already initialized). Without it, the first deposit reverts with
`NotAuthorised()`.

---

## Base USDC quirks

### `depositWithPermitAndWait` could fail on permit fallback (≤ 1.0.1)
Resolved in **1.0.2**. Our `/deposit` route still uses explicit
`usdcAllowance` check → `approveUsdc(amount)` → `depositAndWait` because:

- Combined with the pre-approval below, the `if (allowance < amount)` branch
  almost never fires — so the explicit path is single-tx in practice.
- The behavior is more predictable than relying on permit-fallback paths
  inside the SDK.

### Pre-approve the router with a generous allowance
Without it, `depositIdle()` approves *exactly* the deposit amount, then the
router's `deposit()` reverts with `transfer amount exceeds allowance` on the
exact-equal-allowance edge case. The next sweep cycle succeeds because the
failed approve leaves allowance in place — but you get one `sweep-failure`
event per cycle. Run `scripts/approve-router.mjs 10000` once at setup time
and every subsequent sweep is a single tx with zero failure events.

Divigent confirmed in 1.0.2 that pre-approval is the recommended pattern
for seller-side sidecars, even though their fallback bug is fixed.

---

## Operations

### Public Base RPC will rate-limit you
At ~60 RPC reads/hour (sweep + snapshot tickers + open routes), the public
`mainnet.base.org` starts returning errors. Use Alchemy (10M/mo free tier
is plenty), QuickNode, or Coinbase Developer Platform.

### macOS port 7000 is owned by Control Center
This sidecar defaults to `SIDECAR_PORT=7100`. macOS Sonoma+ binds 7000 to
AirPlay Receiver. `lsof -nP -iTCP:7000 -sTCP:LISTEN` will show `ControlCe`.

### Express can't serialize bigint by default
The Divigent SDK returns USDC amounts as `bigint`, but `JSON.stringify`
throws on them. The canonical workaround is at the top of `src/index.ts`:

```ts
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
```

### Time Machine backs up your `.env` by default
Excluded the file explicitly:

```bash
sudo tmutil addexclusion /path/to/.env
```

---

## Architecture

### Split-process sellers can't use `attachToResourceServer`
Divigent's docs recommend `attachToResourceServer(server, config)` for the
seller side. That requires a TS-resident `x402ResourceServer` instance. If
your resource server lives in Python (FastAPI), Go, Rust, or anywhere else,
the canonical fallback is `divigent.depositIdle({ wallet, minIdleThreshold,
onIdleDeposit, ... })` on a ticker. That's exactly what this sidecar does.

### Ticker overlap on slow RPC
A sweep tx can take 10–20 seconds (preview + simulate + broadcast + wait).
At a 5-minute interval that's normally fine, but a chain stall plus the
snapshot ticker firing concurrently can put two RPC writes in flight. Guard
each ticker with a `busy` flag (or chain promises).

### Graceful shutdown matters under launchd / systemd
SIGTERM during an in-flight sweep tx → the tx broadcasts and mines, but the
SDK callback never fires → your backend never records the deposit event.
This sidecar drains in-flight work for up to 30s before `process.exit(0)`.

### Bearer auth even on localhost
The sidecar binds `127.0.0.1` by default, but local malware reaches
localhost trivially. `SIDECAR_API_TOKEN` is required for `/deposit`,
`/withdraw`, and `/sweep`. Compared via `crypto.timingSafeEqual`.

### Token-bucket rate limit on open routes
`/balance` and `/preview/withdraw` each make an RPC call. Without a limit,
a same-host process can exhaust your Alchemy quota. Global 60/min bucket
in `src/routes.ts`.

---

## Things that worked well (no fix needed, just noting)

- **`ensureInitializedAndWait` idempotency** — safe to call on every boot.
- **`IdleDepositContext`** payload includes everything a dashboard needs:
  `walletBalance`, `reserveFloor`, `idleAmount`, `txHash`, `dedupeKey`. No
  transformations required to display it.
- **`previewWithdrawNet`** correctly converts target USDC → shares,
  including all of Divigent's internal math. Don't try to compute it yourself.
- **`Position` field accrual** — `accruedYield` ticks up live without polling
  any extra endpoint.
- **viem typing across the SDK boundary** is clean — no `any` casts needed
  in well-written integration code.
