---
"@titan-design/factory": patch
---

Add the pure owner presence-proof core: the v1 statement schema, `itemsDigest`, and `verifyProof`, which checks an ECDSA P-256 signature over the received statement bytes before parsing and refuses with a typed reason.
