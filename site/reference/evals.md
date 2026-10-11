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
  (`titan.scorecard/v1`). Strict on write: unknown keys and anything but an exact model id (`MODEL_ID_PATTERN`) are refused.
  Loose on read: unknown keys are kept. The same two modes as `agent-protocol`'s `/trace`.
- **Content hashes.** Canonical JSON (sorted keys, no whitespace), SHA-256. Each hash covers
  every field except the ones listed in `HASH_EXCLUDED_FIELDS`, so a field added later joins
  the identity by default. Locations never count: a prompt's path, a fixture's path, a
  skill's source and the topology module path are dropped, and the prompt content is
  hashed instead. A scorecard key leaves the environment fingerprint out, so a different
  host warns rather than splits.

| Spec | Left out of the hash |
|---|---|
| unit | `title`, `description`, `acceptance`, `visibility` |
| case | `id`, `unit`, `tags`, `humanMinutes`, `solvable`, `visibility`, `provenance.source`, `provenance.ref` |
| variant | `id`, `notes`, `parents` |
| suite | `id`, `version`; the case list is sorted |
| scorecard key | `env` |

A reference from one spec to another is a content hash wherever identity depends on it. A
suite lists cases by hash, so a case's `split` is part of its hash. A `unit` step names its
child as `{ id, version }` and its child variant by content hash, or as `"champion"`, which
resolves when a trial starts; the trial, not the variant hash, records the resolved child.

`startTrial` resolves every `"champion"` once, when the trial starts, and writes a
`titan.trial/v1` record. Its `variant` is always a content hash: a trial run with variant
`"champion"` records the hash of the variant holding the slot at that moment. A `unit` step
whose child is `"champion"` is recorded in `champions`, keyed by step path (`delegate`, or
`delegate/inner` for a champion's own champion step). `scorecardKeysFor` carries `champions`
into the scorecard key, so two different champions never share a key. A trial with no
champion steps omits `champions`, and its key hash is the same as before the field existed.
Old trial records and scorecards without `champions` still load and keep their old key.

## Review outcome corpus

`titan-evals corpus --db <factory.sqlite3> --repos-root <dir>` writes one JSONL row per
`(repo, pr, head)` that Shepherd recorded a review verdict for, and prints the row count and
label histogram to stderr. `buildCorpus` is the same thing as a function, for the replay
runner. It opens the database through a `mode=ro` URI and never writes. Git is read with
`log`, `diff`, `merge-base` and `cat-file` only; nothing fetches.

A row carries the verdict, reviewer, findings and cited paths, `Closer`, the class and
touches `classifyPr` gives the head's diff, the reviewer session's list-price cost,
dispatch-to-verdict latency, and five raw labels: `revert`, `main-red`, `later-fix`,
`owner-override` and `fixer-changed-cited-paths`. From those comes one `label`:

| Label | Rule |
|---|---|
| `pending` | the verdict is under 14 days old, or the owner overrode it with no recorded reason |
| `escaped` | MERGE, and the merge was reverted, read red on main, or had a fix over its lines within 14 days, or the owner abandoned it |
| `clean` | MERGE, merged, and none of those |
| `caught` | FIX_FIRST, and the next head changed a path the review cited |
| `false-block` | FIX_FIRST, and the next head changed no cited path, or the owner merged over it |
| `unresolved` | old enough, but the evidence cannot decide: the PR never merged, the head is missing from the clone, or there is no next head or cited path |

## When to reach for it

You need a stable identity for "this workflow configuration on this suite", or you want to
check that a committed spec still matches the prompt files it names. Retrieval quality has
its own harness, [`retrieval-eval`](/reference/retrieval-eval).

## Example

The product is private, so the import resolves only inside this monorepo's workspace.

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSpec, pinVariantPrompts, variantHash } from "@titan-design/evals";

// Prompt paths are relative to the unit directory, the one holding unit.json.
const unitRoot = "fixtures/summarize-note";
const variant = parseSpec(JSON.parse(await readFile(join(unitRoot, "variants/single-pass.json"), "utf8")));
if (variant.schema === "titan.variant/v1") {
  const pinned = await pinVariantPrompts(variant, (path) => readFile(join(unitRoot, path)));
  console.log(variantHash(pinned));
}
```

## What it deliberately does not do

No trial host beyond `startTrial`'s identity record, no check engine, judge runner or scorecard aggregation yet; those are slices
E3 to E7. Skill trees and topology modules are hashed by their stored digests, not re-read.

## Gotchas

- `variantHash` trusts the stored prompt digests. Call `pinVariantPrompts` first, or use
  `titan-evals validate`, which exits 1 when a stored digest is stale.
- Prompt paths are relative to the unit directory, the nearest ancestor holding `unit.json`.
  Absolute paths, `~`, `..` and backslashes are refused, so a spec never names a machine path.
- Hash a parsed spec, not raw JSON. Parsing fills defaults such as a suite's `trials` and a
  check's `scope`, so a raw spec that omits them hashes differently.
- Array order is significant. A suite's case list is the one exception: it is sorted before
  hashing.

## Where it came from

New. Design: the workflow eval registry design, sections 1 and 9 (Stage 1, slice E1).
