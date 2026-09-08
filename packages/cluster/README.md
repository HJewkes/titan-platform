# @titan-design/cluster

Deterministic template mining for tool output and error blobs: a native TypeScript
Drain (ICWS 2017) with the per-blob signature and frozen-mask recipe in front of it.
Identical blob shapes get identical template ids regardless of order or restarts.

Tier 0 of the titan-platform DAG. No dependencies. Extracted from active-work's AW-28
miner (TP-5).

## Pipeline

```ts
import { Clusterer } from "@titan-design/cluster";

const clusterer = new Clusterer();
const result = clusterer.cluster({ partition: "Bash", text: toolResultText });
// result.templateId, result.maskedSignature, result.extractedParams, result.isNewTemplate
```

1. `extractSignature` reduces a multi-line blob to one anchor line plus a line-count
   bucket, because Drain is per-line and stack traces vary in length. `hasErrorSignal`
   tells you whether that anchor came from a recognized failure shape; successful output
   has unbounded cardinality and should be screened out before clustering.
2. `applyMasks` replaces UUIDs, hashes, paths, durations, line numbers, exit codes, and
   digit runs with typed placeholders, recording the first match of each as a parameter.
   Configs are frozen data (`MaskConfigs`), one per partition, with a generic fallback.
3. `DrainTree` clusters the masked tokens: fixed-depth prefix tree, token-position
   similarity, templates that only ever loosen. One tree per partition via
   `DrainTreeRegistry`, so a `tsc` line and a `vitest` line never merge.
4. `templateId` is a sha256 of `(partition, maskedSignature)`.

## Restarts

`clusterer.snapshot()` captures every tree with its learned wildcards and its
cluster-to-template bindings; `Clusterer.fromSnapshot(snapshot)` restores them. Storing
the snapshot and the occurrences is the caller's concern. A chunked sequence of runs
converges on the same templates as one all-at-once run.

## Tuning

`DrainTreeOptions`: `depth` (4), `simTh` (0.55, higher than Drain3's 0.4 because dev
output is more heterogeneous than syslog), `maxChildren` (100), `maxClusters` (5000,
evicting the least-supported cluster on overflow). `evicting` reports when a partition
has hit the cap.
