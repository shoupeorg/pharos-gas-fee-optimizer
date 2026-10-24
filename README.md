# Pharos Gas Fee Optimizer

A deadline-aware transaction queue for Pharos Atlantic Testnet. It waits for a user's preferred gas price, but attempts the restricted transfer when the UTC deadline arrives, unless the immutable fee or aggregate spending ceiling would be exceeded.

## Network foundation

- Atlantic Testnet: chain ID `688689`, native test token `PHRS`, RPC `https://atlantic.dplabs-internal.com`, explorer `https://atlantic.pharosscan.xyz`.
- The installed official Chain MCP was inspected once. Its live `get_chain_info` returned Pacific Mainnet chain `1672` and `send_raw_transaction` accepts only externally signed bytes; it does not expose an Atlantic selector. Therefore production Atlantic observations and submission use Atlantic JSON-RPC directly. The MCP capability record is preserved in `evidence/foundation.json`.
- Cloudflare Durable Object alarms wake jobs without a browser. They are at-least-once, not exactly-once; the queue is deliberately idempotent.

## Safety and signing model

The app never holds a user's key. A new, isolated testnet-only demo signer is stored only in Cloudflare secrets and checked against `DEMO_SIGNER_ADDRESS`. Owner actions require `OWNER_TOKEN`; public endpoints are read-only. Server validation fixes chain, recipient, value ceiling, empty calldata, fee ceiling, total spending ceiling and rate limit. One Durable Object serializes nonces. No mainnet transaction is supported.

The preferred gas threshold is only an optimization preference. At the deadline it is bypassed, but `maxAuthorizedFeeWei` and the aggregate ceiling are never bypassed. If fresh-enough fee data, RPC access, funding, or authorization is unavailable at the deadline, the job records `DEADLINE_FAILURE` with timestamps. Network availability and mining/finality cannot be guaranteed.

## State machine

`QUEUED → WAITING_FOR_GAS → READY_FAVORABLE | READY_DEADLINE → SUBMITTING → BROADCAST → CONFIRMED`

Terminal alternatives are `FAILED`, `CANCELLED`, and `DEADLINE_FAILURE`. Alarm time, actual wake time, decision, broadcast attempt, acknowledgement and confirmation are retained. Deadline lateness is `max(0, decisionTime − deadline)`.

## Cost comparison

- Initial estimated fee = initial gas estimate × request-time gas price.
- Actual fee = receipt `gasUsed × effectiveGasPrice`.
- Like-for-like baseline = actual `gasUsed × request-time gas price`.
- Difference = like-for-like baseline − actual fee; percentage uses the like-for-like baseline. It may be zero or negative.

All arithmetic uses `BigInt`. Current gas never substitutes for receipt `effectiveGasPrice`; estimates are not described as actual savings.

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
- One signer and approved recipient are intentionally restrictive demonstration controls.
- Atlantic is not exposed by the installed Chain MCP, so live Atlantic execution uses its documented EVM JSON-RPC endpoint.
- A single Durable Object is correct for the demo signer but not a high-throughput multi-signer architecture.

## Submission description

Pharos Gas Fee Optimizer is a durable, deadline-aware native-transfer queue for Atlantic Testnet. It records real gas history, waits for a preferred fee, releases automatically on favorable gas or at the deadline, reconciles ambiguous broadcasts without duplicate transfers, and compares request-time fee expectations with receipt-verified actual cost. Public review is read-only; authenticated owner controls operate a tightly restricted testnet demo signer.
