# owner-proof

**Tier 0 · primitives.** Peer dependency: `zod`.

```sh
npm install @titan-design/owner-proof
```

## The problem it solves

Some actions must happen only when the owner, not an agent on the same account, asked for
them: resolving a factory gate, lifting a Shepherd hold, approving one tool call tool-guard
denied. The owner's Mac signs a short JSON statement with a Secure Enclave P-256 key, behind
Touch ID or the login password. Every consumer then has to verify that statement the same
careful way, and the factory held the only copy.

This package is that verify core. It adds four primitives:

- `verifySigned(input, keys, now, aud, kind)` checks the ECDSA P-256 SHA-256 DER signature
  over the exact received bytes first, then parses them with the kind's zod schema, then
  checks the window, the audience and the kind's own rules. It never throws.
- `keyRing(keys)` indexes PEM or `KeyObject` public keys by key id, and throws on any key that
  is not P-256.
- `keyIdOf(publicKey)` is the first 16 hex characters of sha256 over the SPKI DER.
- `canonical(value)` is sorted-key JSON, so a digest does not depend on key order. It throws
  past 32 levels of nesting.

## When to reach for it

Use it whenever a caller must prove the owner signed for one specific thing. Define a
statement kind: a zod schema that pins a `type` literal and carries `aud`, `keyId`, `iat` and
`exp`, plus a `refusal` function for the checks only that kind knows, such as a digest
compare. To decide which actions need the owner at all, use [authority](./authority.md).

## Example

Verified against 0.1.0.

```ts
import { z } from "zod";
import { keyRing, verifySigned, type StatementKind } from "@titan-design/owner-proof";

const Approve = z.strictObject({
  v: z.literal(1),
  type: z.literal("example.approve"),
  aud: z.string(),
  keyId: z.string(),
  nonce: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  digest: z.string(),
});

const kind = (digest: string): StatementKind<z.infer<typeof Approve>, "digest-mismatch"> => ({
  schema: Approve,
  refusal: (s) => (s.digest === digest ? undefined : "digest-mismatch"),
});

const result = verifySigned({ statementB64, signatureB64 }, keyRing(pems), Date.now() / 1000, "my-host", kind(expected));
if (result.ok) spendNonce(result.statement.nonce);
```

## What it deliberately does not do

- It keeps no state. Nonce replay is the caller's: record `statement.nonce` and refuse a
  repeat.
- It does not load keys from disk or run the signing helper; those land in the same package
  as separate units.
- It allows at most a 300 s window. A caller that wants a shorter one checks it in its kind's
  `refusal`.

## Gotchas

- Dedupe on the nonce, never on the signature bytes. A DER signature re-encoded with high S
  is a different byte string that still verifies.
- Refusals are returned, not thrown: `malformed`, `unknown-key`, `bad-signature`,
  `window-too-long`, `expired` (30 s skew), `not-yet-valid` (60 s skew), `wrong-aud`, or the
  kind's own.
- A signature from a key outside the ring is `bad-signature`, not `unknown-key`;
  `unknown-key` means the ring is empty or the statement names a different key than the one
  that signed it.

## Where it came from

Extracted from the factory's `presence-proof.ts` (TP-2039, TP-2326) so tool-guard, a tier-0
package that cannot import a product, can verify owner approvals with the same code.
