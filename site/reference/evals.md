# evals

**Product.** Private, never published. Depends on `zod` and `commander` only so far.

```sh
pnpm --filter @titan-design/evals build
node products/evals/dist/bin.js validate products/evals/fixtures/summarize-note/*.json
```

## The problem it solves

Agent workflows were compared by impression: a new prompt, model or skill "seemed better",
and nothing recorded which exact configuration produced which result. This product is the
eval registry for units of work. Slice E1 (TP-687) adds the vocabulary and the identity
rule everything later depends on.

- **Specs.** zod schemas for a unit (`titan.unit/v1`), a variant (`titan.variant/v1`), a
  case (`titan.case/v1`), a suite with its checks (`titan.suite/v1`) and a scorecard
  (`titan.scorecard/v1`). Strict on write: unknown keys and model aliases are refused.
  Loose on read: unknown keys are kept. The same two modes as `agent-protocol`'s `/trace`.
- **Content hashes.** Canonical JSON (sorted keys, no whitespace), SHA-256. Each hash covers
  only what changes behaviour: a variant's hash covers its topology source hash, every step,
  and the content of every prompt file it references, but not its notes or the prompt's
  path. A scorecard key leaves the environment fingerprint out, so a different host warns
  rather than splits.

## When to reach for it

You need a stable identity for "this workflow configuration on this suite", or you want to
check that a committed spec still matches the prompt files it names. Retrieval quality has
its own harness, [`retrieval-eval`](/reference/retrieval-eval).

## Example

```ts
import { readFile } from "node:fs/promises";
import { parseSpec, pinVariantPrompts, variantHash } from "@titan-design/evals";

const variant = parseSpec(JSON.parse(await readFile("variants/single-pass.json", "utf8")));
if (variant.schema === "titan.variant/v1") {
  const pinned = await pinVariantPrompts(variant, (path) => readFile(path));
  console.log(variantHash(pinned));
}
```

## What it deliberately does not do

No trial host, check engine, judge runner or scorecard aggregation yet; those are slices
E3 to E7. Skill trees and topology modules are hashed by their stored digests, not re-read.

## Gotchas

- `variantHash` trusts the stored prompt digests. Call `pinVariantPrompts` first, or use
  `titan-evals validate`, which exits 1 when a stored digest is stale.
- Prompt paths are relative to the unit directory, the nearest ancestor holding `unit.json`.
  Absolute paths, `~` and `..` are refused, so a spec never names a machine path.
- Array order is significant. A suite's case list is the one exception: it is sorted before
  hashing.

## Where it came from

New. Design: the workflow eval registry design, sections 1 and 9 (Stage 1, slice E1).
