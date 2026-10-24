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

One global Durable Object accepts only one outstanding job and protects the restricted signer with revision compare-and-set plus fenced recovery leases; it does not assume an external RPC `await` keeps other requests out. Job, budget reservation and recovery alarm are committed atomically. Nonce reservation establishes the cancellation boundary; signed bytes and their deterministic hash are persisted before broadcast. A crashed owner recovers each intermediate phase and can only re-broadcast identical bytes.

Every callback revalidates revision, state, fence and transaction identity after external awaits. Terminal job transition and ledger commit/release occur in the same transaction. Receipt hash/sender/recipient and quantities are checked before accounting. A missing fee or transaction that is unmined/dropped beyond bounded reconciliation stays conservatively reserved and blocks new acceptance; no replacement transfer is created.

The signer exists only as a Cloudflare secret. Public APIs redact signed bytes and expose read-only history. Only native Atlantic test-token transfers to the configured recipient, with empty calldata and bounded value/fees, are accepted.
