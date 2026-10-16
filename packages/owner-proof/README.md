# @titan-design/owner-proof

Owner-signed statements: canonical JSON, a P-256 key ring and an exact-bytes ECDSA verify core
generic over a zod schema.

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

## Use

```ts
import { verifySigned, keyRing, type StatementKind } from "@titan-design/owner-proof";

const kind: StatementKind<MyStatement, "digest-mismatch"> = {
  schema: MyStatementSchema, // pins a `type` literal, aud, keyId, iat, exp
  refusal: (s) => (s.digest === expected ? undefined : "digest-mismatch"),
};
const result = verifySigned({ statementB64, signatureB64 }, keyRing(pems), nowSeconds, host, kind);
```

`verifySigned` never throws. It refuses with `malformed`, `unknown-key`, `bad-signature`,
`window-too-long` (over 300 s), `expired` (30 s skew), `not-yet-valid` (60 s skew), `wrong-aud`
or the kind's own refusal.

## Gotchas

- Record `statement.nonce` and refuse a repeat. Dedupe on the nonce, never on the signature
  bytes: a DER signature re-encoded with high S is different bytes that still verify.
- The schema must pin a `type` literal, so one statement type never parses as another signed
  by the same key.
- `keyRing` throws on any key that is not ECDSA P-256 rather than skipping it.

Extracted from `products/factory/src/presence-proof.ts` (TP-2326).
