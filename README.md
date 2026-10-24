# Pharos Gas Fee Optimizer

A deadline-aware transaction queue for Pharos Atlantic Testnet. It waits for a user's preferred gas price, but attempts the restricted transfer when the UTC deadline arrives, unless the immutable fee or aggregate spending ceiling would be exceeded.

## Network foundation

- Atlantic Testnet: chain ID `688689`, native test token `PHRS`, RPC `https://atlantic.dplabs-internal.com`, explorer `https://atlantic.pharosscan.xyz`.
- The installed official Chain MCP was inspected once. Its live `get_chain_info` returned Pacific Mainnet chain `1672` and `send_raw_transaction` accepts only externally signed bytes; it does not expose an Atlantic selector. Therefore production Atlantic observations and submission use Atlantic JSON-RPC directly. The MCP capability record is preserved in `evidence/foundation.json`.
- Cloudflare Durable Object alarms wake jobs without a browser. They are at-least-once, not exactly-once; every write uses a stored revision and submission fencing.

## Safety and signing model

The app never holds a user's key. A new, isolated testnet-only demo signer is stored only in Cloudflare secrets and checked against `DEMO_SIGNER_ADDRESS`. Owner actions require `OWNER_TOKEN`; public endpoints are read-only. Server validation fixes chain, recipient, value ceiling, empty calldata, fee ceiling, total spending ceiling and rate limit. The RPC's live `eth_chainId` must equal `688689` both when a job is accepted and immediately before submission. No mainnet transaction is supported.

The supported scope is deliberately **one outstanding job**. Acceptance atomically rejects another nonterminal job before reserving budget. The Durable Object stores a revision, fenced recovery lease, nonce reservation, signed bytes, deterministic transaction hash, budget reservation and recovery alarm. Correctness does not depend on JavaScript request handlers remaining sequential. A crashed or ambiguous submission is reconciled by the expected hash and may only re-send identical bytes up to a bounded attempt count.

If an acknowledged transaction stays unmined or disappears for 30 minutes, it becomes `UNRESOLVED`: no replacement transfer is created, its conservative reservation remains held, receipt checks continue at a slower interval, and new jobs remain blocked. A mined receipt without verified fee fields becomes `FEE_ACCOUNTING_PENDING` under the same conservative rule.

The preferred gas threshold is only an optimization preference. At the deadline it is bypassed, but fee, aggregate, signer, recipient and network safety checks are never bypassed. Gas is freshly observed during processing; observations older than 30 seconds are rejected rather than described as current. Acceptance rechecks feasibility after RPC validation. Scheduled alarm, actual handler wake, decision, real broadcast attempt, acknowledgement and confirmation are separate timestamps. Submission lateness is measured from the actual broadcast attempt. Network availability and mining/finality cannot be guaranteed.

## State machine

`QUEUED → WAITING_FOR_GAS → READY_FAVORABLE | READY_DEADLINE → SUBMITTING → BROADCAST → CONFIRMED`

Terminal alternatives are `FAILED`, `CANCELLED`, and `DEADLINE_FAILURE`; conservative nonterminal states are `FEE_ACCOUNTING_PENDING` and `UNRESOLVED`. Cancellation is allowed only before the atomic nonce-reservation boundary. Once submission wins, cancellation is refused and the reservation cannot be released while identical signed bytes remain viable.

## Cost comparison

- Initial estimated fee = initial gas estimate × request-time gas price.
- Actual fee = receipt `gasUsed × effectiveGasPrice`.
- Like-for-like baseline = actual `gasUsed × request-time gas price`.
- Difference = like-for-like baseline − actual fee; percentage uses the like-for-like baseline. It may be zero or negative.

All arithmetic uses `BigInt`. Current gas never substitutes for receipt `effectiveGasPrice`; a matching transaction's historical `gasPrice` may fill a missing receipt field. Successful and failed mined transactions both report actual paid gas, readable PHRS, exact wei, and signed like-for-like percentages.

## Public monitoring semantics

Gas observations are collected only during authenticated job acceptance and durable job processing. Public refresh reads those saved observations and never triggers a chain request. Production Atlantic calls use JSON-RPC. Chain MCP was used only for the preserved foundation capability inspection; the production queue does not claim to invoke MCP.

## Development

```powershell
npm install --cache .npm-cache
npm test
npm run build
npx wrangler dev
```

See [ARCHITECTURE.md](ARCHITECTURE.md), [SKILL.md](SKILL.md), and [STATUS.md](STATUS.md). Real demonstrations are intentionally pending explicit funding authorization; fixtures never masquerade as chain evidence.

## Limitations

- A submission deadline targets broadcast; it cannot guarantee acknowledgement, mining, or finality.
- One signer, one approved recipient and one outstanding job are intentional demonstration controls.
- Atlantic is not exposed by the installed Chain MCP, so live Atlantic execution uses its documented EVM JSON-RPC endpoint.
- `UNRESOLVED` and fee-pending jobs require verified receipt data or operator investigation; they intentionally block new acceptance rather than risk a conflicting transfer.

## Submission description

Pharos Gas Fee Optimizer is a durable, deadline-aware native-transfer queue for Atlantic Testnet. It records real gas history, waits for a preferred fee, releases automatically on favorable gas or at the deadline, reconciles ambiguous broadcasts without duplicate transfers, and compares request-time fee expectations with receipt-verified actual cost. Public review is read-only; authenticated owner controls operate a tightly restricted testnet demo signer.
