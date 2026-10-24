# Status

Updated: 2026-10-24

## Durability correction (2026-10-24)

- Funding and all broadcasts remain paused. No live job, evidence capture, signing, or chain write was performed for this correction.
- Fixed stale terminal-state persistence by committing the current transition and matching reservation ledger mutation in one storage transaction. Reservation IDs and consumed-state guards make repeated/concurrent completion idempotent.
- Added an explicit durable per-signer submission lease. Nonce reservation, signed bytes and deterministic hash are persisted before broadcast; unresolved submissions block a different job and recover by reconciling or resending only identical bytes.
- A known receipt without `effectiveGasPrice` now remains `BROADCAST` with `feeAccountingPending`; its conservative reservation stays held and it is never rebroadcast merely because fee accounting is incomplete.
- Added live `eth_chainId` verification at job acceptance and again before signing/submission. Any value other than Atlantic `688689` fails before signing or broadcast.
- Local verification after the correction: 25/25 tests passed and the production Rollup build passed. The Rollup dependency `this` rewrite warning is unchanged and non-fatal.
- Publication/deployment of engine `gas-fee-optimizer/0.2.0-durable-submission` is the only remaining stage.

## Completed

- Created separate project and reused the verified Pharos PNG and approved retro desktop styling.
- Inspected installed Chain MCP schemas and performed one foundation read: configured MCP is Pacific Mainnet `1672`; Atlantic is not selectable.
- Confirmed Atlantic parameters from current Pharos documentation ecosystem: chain `688689`, RPC and explorer recorded in `evidence/foundation.json`.
- Implemented shared exact-arithmetic engine, restricted native-transfer validation, Durable Object queue, persistent gas observations, durable alarms, explicit state machine, owner authentication, rate/fee/spending gates, nonce serialization, idempotent ambiguous-broadcast reconciliation, receipts and cost comparison.
- Implemented English-only public read-only UI, CLI, root `SKILL.md`, architecture and tests.
- Final local suite: 21/21 tests passed; production Rollup build passed.
- Generated one isolated Atlantic demo signer locally and persisted its key only in ignored secret files. Configured its own address as the sole approved, recoverable recipient. No secret was printed or committed.
- Verified the local UI visually: approved Pharos logo, black desktop, blue Windows-style title bar, off-white panels, sharp borders, responsive layout, stable English labels and read-only disclosure all render correctly.
- Initialized Git and committed the implementation. Created the public GitHub repository `shoupeorg/pharos-gas-fee-optimizer` through the authenticated browser session.
- Sandbox Git publication is blocked by `cannot spawn sh: No such file or directory` / `could not read Username`; one normal-PowerShell resume script is ready.
- Sandbox Wrangler secret configuration is blocked because non-interactive Wrangler cannot use the saved interactive session without `CLOUDFLARE_API_TOKEN`; no OAuth retry was started and no secret was changed remotely.
- User completed the normal-PowerShell resume stage. GitHub `main` and local `HEAD` match at `5cda783eb8770402bb87826f325a60346316b9d3`.
- Cloudflare deployment succeeded at `https://pharos-gas-fee-optimizer.shoupeorg.workers.dev` with Version ID `1642f1b6-2d62-44cc-8f2d-e62583e756de`.
- Public verification passed: UI and PNG return HTTP 200; engine is `gas-fee-optimizer/0.1.0`; chain ID is `688689`; scheduler is a Durable Object alarm; owner controls are configured; unauthenticated job creation returns HTTP 401. The deployed UI was visually inspected.

## Remaining

1. Publish and deploy the focused durability correction, then verify the public engine version and read-only endpoints.
2. Only after separate authorization: fund `0xF825689D4D6c5C2C306353E3A0905cB84bA234e0` with the previously documented bounds and capture receipt-verified demonstrations.

No signer has been funded and no transaction has been signed or broadcast.
