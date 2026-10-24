# Status

Updated: 2026-10-24

## Authorized receipt-verified demonstrations (2026-10-24)

- Verified the funded signer on Atlantic before execution: RPC chain ID `688689`, starting balance `0.1 PHRS`. No further funding was requested.
- Executed exactly two sequential 1-wei self-transfers to the allowlisted signer. Job 1 reached `CONFIRMED` before job 2 was accepted; no additional jobs were created.
- Favorable job `6f769894-fe9b-4a72-80e8-78d42913bdd0` released as `FAVORABLE_GAS`, transaction `0x9c2de02b8b95557628620cc73e08cf0a2b71ccd42085c464f312655bf89204d8`, receipt block `31823602`, actual fee `210000000000000 wei`.
- Deadline job `94c39eb1-bae3-4c81-bc99-47bdbb55a7bf` remained above its zero-gwei preference through four saved scheduler observations and released as `DEADLINE`, without a manual run request. Transaction `0xcba4ec4af526727fe07922c4804ffebae636b5b001ed76b2eda631d07350ebaa`, receipt block `31823648`, actual fee `210000000000000 wei`.
- Deadline `2026-10-24T13:10:19.956Z`; actual scheduler wake `2026-10-24T13:10:19.956Z`; decision `2026-10-24T13:10:20.667Z`; broadcast attempt `2026-10-24T13:10:21.535Z`; measured lateness `1579 ms`; RPC acknowledgement `2026-10-24T13:10:21.744Z`; confirmation `2026-10-24T13:10:31.924Z`.
- Gas stayed at 10 gwei. Each request-time like-for-like baseline and actual receipt fee was `210000000000000 wei`, so savings are `+0.00%`, not inferred fluctuations.
- Total actual gas expenditure: `420000000000000 wei` (`0.00042 PHRS`). Conservative ledger spend including the two 1-wei transfer values: `420000000000002 wei` (`0.000420000000000002 PHRS`), below the authorized `0.0025 PHRS` aggregate ceiling. Ending balance: `0.09958 PHRS`.
- RPC receipt verification independently matched both transaction hashes, success status, sender/recipient, gas used and effective gas price. Versioned saved records are in `evidence/`; public copies back the two reviewer buttons.
- Final local verification after adding the records: 27/27 tests passed and the production build passed. Publication/deployment verification is the only remaining stage.

## Consolidated correctness pass (historical pre-authorization record, 2026-10-24)

- Funding and every signing/broadcast path remained paused during this pass; all submission tests use controlled RPC mocks and an isolated test key.
- Selected and enforced one-outstanding-job scope. A second job is rejected atomically before budget reservation. `UNRESOLVED` or fee-pending signed work continues to block acceptance rather than risk a replacement transfer.
- Added revision compare-and-set to all state writers and fenced recovery leases across nonce reservation, signing, broadcast, reconciliation, receipt handling and errors. Stale callbacks cannot regress a newer state or transaction identity.
- Job, ledger reservation and initial recovery alarm are persisted in one transaction. Alarm recomputation reads current durable state transactionally, so competing schedulers retain the earliest current requirement.
- Cancellation and submission now meet at the nonce-reservation transaction: cancellation before it prevents signing/broadcast; after it cancellation is refused and funds remain reserved.
- RPC acknowledgement and receipt identity are checked against the locally signed hash. Receipt quantities and all RPC quantities fail closed when malformed.
- Bounded reconciliation resends only identical bytes. After 30 minutes without a transaction/receipt the job becomes `UNRESOLVED`, keeps its reservation, slows polling and never creates a replacement.
- Deadline evidence now separates scheduled alarm, handler wake, decision, actual broadcast attempt, acknowledgement and confirmation. Lateness uses the real attempt time; stale observations are rejected.
- Fixed signed percentage padding, negative unit formatting, sub-gwei display, explicit UTC parsing and visible PHRS/wei comparison rows for successful or failed mined receipts.
- Gas history is accurately described as saved observations collected during authenticated acceptance/job processing. Atlantic runtime transport is JSON-RPC; MCP remains foundation evidence only.
- Local controlled verification: 27 race, crash, validation, time-zone, arithmetic and state-machine tests passed; production build passed. Installed Wrangler runtime types also confirm alarm operations participate in Durable Object storage transactions. Live deployment/public verification remains to be performed once after publication. Receipt-based evidence remains pending explicit funding authorization.

## Durability correction (historical pre-authorization record, 2026-10-24)

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

1. Publish this final evidence/documentation commit and deploy the changed public evidence assets once.
2. Verify the public reviewer buttons and both explorer transaction-detail links. No further transaction is authorized or required.
