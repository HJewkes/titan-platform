---
"@titan-design/factory": minor
---

Add `applyProof`, the server-side core for owner-signed gate answers. It verifies a signed statement with `verifyProof` and refuses a nonce it has already seen. It then checks each item against its live gate. A batch may hold only plain merge gates answered `merge` at the listed head; release and hardware gates stay one per proof. The proof (statement, signature, key id, nonce, audience, window) is recorded before any item fires. Each item fires only while its gate is still pending at its exact head, as `owner-terminal` `key:<keyId>` on channel `factory-proof`. An item that moved or closed is skipped and named. New tables `gate_batch` and `gate_batch_item` (migration 15).
