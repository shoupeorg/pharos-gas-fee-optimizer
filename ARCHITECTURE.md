# Architecture

```text
Public reviewer UI ──GET──> Cloudflare Worker ──> Durable Object (global queue)
Owner control ─Bearer token─┘                    │
                                                  ├─ strongly consistent job/gas/ledger storage
                                                  ├─ one durable alarm for the next due job
                                                  ├─ serialized nonce allocation and signing
                                                  └─ Atlantic JSON-RPC: gas, estimate, broadcast, receipt

Alarm/retry → inspect time first → favorable OR deadline release
           → hard fee/aggregate gates → persist hash+nonce+raw tx
           → broadcast identical signed bytes → reconcile → receipt
```

One global Durable Object protects the restricted demo signer with a persisted lease; it does not assume an external RPC `await` keeps other requests out. Nonce reservation, job ownership and signed bytes are committed transactionally before broadcast. A crashed owner recovers the lease, reconciles the known receipt/hash, and can only re-broadcast identical bytes. A different job cannot reserve a nonce while an earlier submission is unresolved.

Terminal job transition and its ledger commit/release occur in the same storage transaction and require the matching, unconsumed reservation. Repeated alarms and concurrent receipt checks therefore cannot debit twice or restore stale state. A known receipt with unavailable fee fields remains nonterminal for accounting, holds its full conservative reservation, and is polled for complete receipt data without rebroadcast.

The signer exists only as a Cloudflare secret. Public APIs redact signed bytes and expose read-only history. Only native Atlantic test-token transfers to the configured recipient, with empty calldata and bounded value/fees, are accepted.
