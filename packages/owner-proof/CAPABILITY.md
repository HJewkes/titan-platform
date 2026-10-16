# owner-proof: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You must accept an action only when the owner signed a statement for it with an ECDSA P-256 key (such as the Secure Enclave key behind Touch ID). `verifySigned` checks the DER signature over the exact received bytes against a `keyRing` of installed public keys before it parses anything, then the zod schema, the issue and expiry window, the audience and your statement kind's own checks; `canonical` gives sorted-key JSON for digests. It keeps no state, so nonce replay is yours to record. To decide which actions need the owner at all, use authority.
