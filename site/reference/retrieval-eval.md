# retrieval-eval

**Product.** Private, never published. Depends on
[`retrieval`](/reference/retrieval), [`store-sqlite`](/reference/store-sqlite) and
[`embed`](/reference/embed).

```sh
pnpm --filter @titan-design/retrieval-eval build
node products/retrieval-eval/dist/bin.js --help
```

## The problem it solves

Retrieval changes were being argued from intuition. Every proposal — a vector index,
playbook recall, ingesting an archive, retuning the search weights — was a claim about
whether something useful would surface, with no way to tell whether it had. The weights
shipped in `@titan-design/retrieval` 0.2.0 were tuned by hand against one corpus snapshot
and left an explicit open loop saying they had no regression harness.

This is that harness. It mines query/label pairs from Claude Code transcripts with no model
in the loop, scores candidate retrievers on them, and reports recall, precision, MRR and
the characters each candidate would inject.

The primitive it adds is the **observed-read label**: the query is a trigger text that
really occurred (a spawn brief, a session's open loops) and the labels are the files the
agent really opened afterwards. Nobody judges relevance, so nobody's judgement is in the
number.

## When to reach for it

Before changing retrieval behaviour, and after. Re-run it to see whether a weight change,
a new index, or a new corpus moved recall, and compare against `date-order-notes` — what
the system injects today — rather than against zero.

Do not reach for it to evaluate answer quality or a generated summary. It measures whether
a document was surfaced, nothing about what was done with it.

## Example

Verified against the 2026-09-15 corpus snapshot in
[`products/retrieval-eval/REPORT.md`](https://github.com/HJewkes/titan-platform/blob/main/products/retrieval-eval/REPORT.md).

```sh
# 643 pairs: 608 spawn, 35 bootstrap
node products/retrieval-eval/dist/bin.js mine --out pairs.jsonl

# 16 cells: 2 arms x 4 candidates x 2 query variants
node products/retrieval-eval/dist/bin.js run pairs.jsonl

# does anyone call a recall tool at all?
node products/retrieval-eval/dist/bin.js uptake --since 2026-09-01
```

The library entry exposes the same pieces for a bespoke run:

```ts
import { mineSpawnArm, notesFts, runEval } from "@titan-design/retrieval-eval";
```

## What it deliberately does not do

No LLM anywhere — not in the label path, not in the scoring path. A judged relevance set
would be a better measurement and a worse regression harness, because it could not be
regenerated on every corpus refresh without a human or a model in the way.

It does not write. The session graph is opened `readonly: true`, no `active-work` command
that mutates is ever invoked, and nothing under the active root is touched.

## Gotchas

**The labels undercount, structurally.** They are files the agent went on to read, so a
relevant file the agent never found is invisible. Recall here means "would retrieval have
surfaced what the agent went looking for", not "everything it should have known". Treat
every absolute number as a floor and compare candidates to each other.

**`terms()` drops tokens of two characters or fewer**, mirroring the bootstrap ranker. Both
halves of `TP-84` are two characters, so a task ref contributes nothing to a query. This is
faithful to production, not a bug in the harness, and it is worth fixing in production.

**The injected-character column is not comparable across all four candidates.**
`active-work-search` reports excerpt length, the two span candidates report matched span
length, and `date-order-notes` reports whole file size — because that is what each would
actually cost a prompt.

**The bootstrap arm is small** (35 pairs) and will not grow much: most session records
pre-date transcript ids, and older transcripts get pruned. Read its numbers as directional.

## Where it came from

New, for TP-84, after the owner asked for an eval harness before any more retrieval
features landed. The uptake counter is a port of the throwaway script that produced the
2026-09-15 baseline, moved into the package so the number stays reproducible.
