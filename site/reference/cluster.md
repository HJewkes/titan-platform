# cluster

**Tier 0 · primitives.** No dependencies at all.

```sh
npm install @titan-design/cluster
```

## The problem it solves

An agent's tool output produces thousands of error blobs that are the same three failures
wearing different paths, uuids, and durations. Counting raw strings tells you nothing.

This is a native TypeScript **Drain** (ICWS 2017) with a per-blob signature and a frozen
mask recipe in front of it. Identical blob shapes get identical template ids regardless of
order or restarts.

## When to reach for it

You have high-volume semi-structured text — tool results, stack traces, log lines — and you
want a stable handful of templates plus the parameters that varied. Determinism is the
selling point: no model, no embeddings, same answer every run.

## Example

Verified against 0.1.0.

```ts
import { Clusterer, hasErrorSignal } from "@titan-design/cluster";

const clusterer = new Clusterer();

const a = clusterer.cluster({ partition: "Bash", text: "Error: ENOENT: no such file or directory, open '/tmp/a-1.txt'" });
const b = clusterer.cluster({ partition: "Bash", text: "Error: ENOENT: no such file or directory, open '/tmp/b-2.txt'" });

a.templateId === b.templateId;  // true
a.isNewTemplate;                // true
b.isNewTemplate;                // false
a.maskedSignature;              // "Error Error: ENOENT: no such file or directory, open '<PATH>' [<NUM>]"

hasErrorSignal("Bash", "Error: ENOENT: no such file");  // true
hasErrorSignal("Bash", "ok");                           // false
```

## The pipeline

1. **`extractSignature`** reduces a multi-line blob to one anchor line plus a line-count
   bucket, because Drain is per-line and stack traces vary in length. `hasErrorSignal`
   reports whether that anchor came from a recognised failure shape.
2. **`applyMasks`** replaces UUIDs, hashes, paths, durations, line numbers, exit codes, and
   digit runs with typed placeholders, recording the first match of each as a parameter.
   Configs are frozen data (`MaskConfigs`), one per partition, with a generic fallback.
3. **`DrainTree`** clusters the masked tokens: fixed-depth prefix tree, token-position
   similarity, templates that only ever loosen. `DrainTreeRegistry` keeps one tree per
   partition, so a `tsc` line and a `vitest` line never merge.
4. **`templateId`** is a sha256 of `(partition, maskedSignature)`.

## Gotchas

**`hasErrorSignal(partition, text)` takes two arguments** — the partition first, then the
text. Screen with it before clustering: successful output has unbounded cardinality and
would produce one template per invocation. In a real run over eight transcripts, 4 candidate
blobs screened down to 1 that was worth clustering.

**Snapshot across restarts.** `clusterer.snapshot()` captures every tree with its learned
wildcards and cluster-to-template bindings; `Clusterer.fromSnapshot(snapshot)` restores
them. Storing the snapshot and the occurrences is the caller's job. A chunked sequence of
runs converges on the same templates as one all-at-once run.

**Only the generic mask config exists today.** Per-tool configs (`Bash.ts`, `test.ts`, …)
were meant to come from a DeepParse mask-bootstrap script, which is not built.
`DEFAULT_MASK_CONFIGS` holds `generic` only, so every partition falls back to it. Pass
`new Clusterer({ masks })` if you need per-partition rules now.

**Tuning defaults are not Drain3's.** `depth` 4, `simTh` **0.55** (Drain3 uses 0.4, but dev
output is more heterogeneous than syslog), `maxChildren` 100, `maxClusters` 5000, evicting
the least-supported cluster on overflow. `evicting` reports when a partition has hit the cap.

## Where it came from

Genuinely new here, written for active-work's miner (AW-28) and extracted immediately.
Nobody in the four source projects had a clusterer.
