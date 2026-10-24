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

One global Durable Object intentionally serializes the restricted demo signer. Alarms are at-least-once, so every transition is idempotent. Before any network message, `SUBMITTING`, the nonce, signed bytes and deterministic hash are durable. An ambiguous acknowledgement never creates a new transaction: reconciliation checks the known hash and only re-broadcasts identical bytes.

The signer exists only as a Cloudflare secret. Public APIs redact signed bytes and expose read-only history. Only native Atlantic test-token transfers to the configured recipient, with empty calldata and bounded value/fees, are accepted.
