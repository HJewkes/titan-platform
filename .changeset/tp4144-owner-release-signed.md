---
"@titan-design/factory": patch
---

`shepherd owner-release` from an agent-chat shell no longer takes the presence helper's bare proof UUID. The owner now signs a `titan-factory.hold-release` statement for the run, PR, head and owner-asked hold, and the factory records it in the gate batch ledger. Before it lifts anything, `ownerRelease` re-verifies that record against the owner key ring and the live hold, then spends it. A bare or unknown confirmEvent, a record signed by a key outside the ring, and a statement for another PR, head or hold (including a re-placed hold with the same text) are refused with exit 77. A presence helper without a signing key can no longer release from an agent-chat shell.
