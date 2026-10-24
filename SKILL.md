---
name: pharos-gas-fee-optimizer
description: Safely inspect and operate the Pharos Atlantic deadline-aware native-transfer queue. Use for gas history, job readiness, deadlines, receipts, and exact fee comparisons.
---

# Pharos Gas Fee Optimizer

Use this skill only for Pharos Atlantic Testnet (`chainId 688689`). Never request, print, store, or accept a user's private key.

## Workflow

1. Read `GET /api/meta`; stop if the network or engine is unexpected.
2. Read `GET /api/gas-history` and report genuine observations, including flat prices and errors.
3. Read `GET /api/jobs`; explain the preferred threshold, hard maximum fee, UTC deadline, next alarm, and current state separately.
4. For a new owner-authorized demo job, validate the approved recipient, minimal native value, decimal-string gas preference, hard fee maximum, monitoring interval, and future UTC deadline. Submit only through `POST /api/jobs` with the owner token. Never put the token in logs or URLs.
5. After broadcast, verify the saved receipt. Compute actual fee only as `gasUsed × effectiveGasPrice`; compare it with `gasUsed × initialGasPrice`. Never call an estimate actual savings.
6. Treat `DEADLINE_FAILURE`, `FAILED`, unknown fee data, unavailable RPC, or missing receipt fields honestly. A deadline is a broadcast target, not an inclusion guarantee.

Public reviewer use is read-only. Owner actions are authenticated and the server signer is restricted to one recipient, minimal value, chain 688689, empty calldata, per-job fee maximum, aggregate ceiling, idempotent nonce handling, and rate limits.
