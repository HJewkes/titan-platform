---
"@titan-design/factory": patch
---

`titan-factory gate resolve` from an agent-chat shell now proves the owner's presence with a record the gate store checks, not a bare UUID (TP-4066). The CLI asks the owner's Secure Enclave key to sign a `titan-factory.gate-presence` statement for exactly that gate and answer (the same Touch ID dialog), verifies it against the root-owned owner key ring, and records it in the gate batch ledger. The resolver's `confirmEvent` names that record (`gate-batch:<id>`). The gate store's `authorize` refuses a `factory-cli` confirmEvent that names no record, a record for another gate, a spent record, or a record whose stored signature does not verify against the owner's keys, and spends the record when it admits it. The owner's own terminal (no agent marker) is unchanged. An agent-chat shell now also needs the owner key in `/etc/titan-factory/owner-keys`, as the remote resolve-proof route already does.
