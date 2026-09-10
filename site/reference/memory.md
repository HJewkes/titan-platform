# memory

**Tier 2 · domain.** Depends on [`store-sqlite`](/reference/store-sqlite),
[`embed`](/reference/embed), and [`retrieval`](/reference/retrieval). `zod` v4 is a peer.

```sh
npm install @titan-design/memory zod
```

## The problem it solves

Agent "memory" usually means an append-only pile of notes that grows until recall is noise.
Nothing ever gets demoted, near-duplicates accumulate, and a rule that was wrong last month
still reads as confidently as one that has worked thirty times.

This is a **decaying rule playbook**: what worked, what did not, with each rule's confidence
derived from an append-only feedback log. Restating a rule is feedback on it, not a new row.
A rule that keeps causing harm inverts into an anti-pattern.

## When to reach for it

You want an agent to carry lessons between sessions and you want that store to stay small
and honest without a human curating it.

## Example

Verified against 0.1.0.

```ts
import { PlaybookStore, curate, memoryMigration, recall } from "@titan-design/memory";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";

const db = openDatabase("state.sqlite3");
runMigrations(db, [memoryMigration(1)]);
const store = new PlaybookStore(db);

// Zero-LLM path: the agent that just learned something writes it down.
curate(
  store,
  [{ type: "add", content: "Pin npm to 11 in release jobs", category: "ci", tags: ["ci", "release"] }],
  { provenance: { sessionRef: "session:s-1", byteOffset: 4096 } },
);
// { added: [ '…' ], skipped: [] }

// Say it again, differently. It folds into feedback rather than a second row.
curate(store, [{ type: "add", content: "pin NPM to 11 in release jobs" }]);

const { bullets, antiPatterns, deprecatedWarnings, degraded } = await recall(store, "release job npm");
// bullets: [{ content: 'Pin npm to 11 in release jobs', maturity: 'candidate', helpfulCount: 1, … }]
```

## Model

A **bullet** has content, category, tags, scope, type (`rule` | `anti-pattern`), kind,
source, state (`draft` | `active` | `retired`), maturity (`candidate` | `established` |
`proven` | `deprecated`), a pinned flag, a half-life, and provenance
(`{ sessionRef, byteOffset }`).

**Feedback is an immutable log** of `helpful` / `harmful` events. Counts and scores are
computed at read time, so changing the decay parameters re-scores all of history for free.

**Storage is the kit**: bullets are interval entities, `supersedes` is an edge, embeddings
live in `cache_blob` keyed by content hash, per-session progress is a watermark.

## Scoring

```
decayedValue(event) = 0.5 ^ (ageDays / halfLifeDays)          halfLifeDays = 90 by default
effectiveScore      = (decayedHelpful - 4 * decayedHarmful)
                      * { candidate 0.5, established 1, proven 1.5, deprecated 0 }
```

Maturity: under three events is a candidate; over 30% harmful is deprecated; ten helpful with
under 10% harmful is proven; otherwise established. Promotion jumps to the earned rung,
demotion drops one rung per pass, a score under -3 deprecates outright, and **pinned bullets
never move**.

Staleness is separate from decay: silence for 180 days flags a bullet for re-validation
rather than demoting it.

## Curation

`curate` is deterministic — no model involved. Deltas are `add` | `helpful` | `harmful` |
`replace` | `deprecate` | `merge`, zod-validated as `PlaybookDeltaSchema`. The curator:

1. drops duplicate deltas within the batch (one vote per bullet per batch);
2. refuses any `add` near a human-blocked pattern (`store.block`);
3. folds an exact or Jaccard ≥ 0.85 duplicate `add` into a `helpful` on the existing bullet,
   unless the polarity differs, in which case it is added and flagged as a conflict;
4. applies replacements and merges by adding a successor and retiring the originals with
   `supersedes` edges;
5. inverts a non-pinned rule whose decayed harm is at least 3 and more than twice its help
   into an `AVOID:` anti-pattern;
6. runs the maturity pass.

## Recall

```
keywordScore   = 3 per exact token + 1 per substring + 5 per tag match
relevanceScore = keyword * (1 - w) + similarity * w        w = 0.6 with a semantic index
finalScore     = relevanceScore * max(0.1, effectiveScore)
```

Filtering happens on **relevance**, not final score, so a topical bullet with low confidence
still surfaces — near the bottom, where you can see it was tried. `MemoryVectors` builds the
semantic index from `cache_blob` with any `Embedder`; without one, `degraded` explains why
scoring fell back to keywords.

## Reflection

`reflectSession` is the one stage that may call a model. You supply a `Reflector` that turns
a session diary into proposed deltas; the loop feeds the growing playbook and prior deltas
back in for up to three iterations, stops on nothing new or at 50 deltas, validates every
item, then curates with the session's provenance and advances the watermark. Invalid output
is reported in `rejected`, never thrown.

## Gotchas

**Provenance is an option on `curate`, never a field on a delta.** A model cannot claim a
source it did not have.

**Confidence multiplies relevance, it does not gate it.** A bullet with a terrible score
still appears if it is on-topic. That is deliberate: silently hiding a rule an agent wrote
makes the playbook untrustworthy.

## Where it came from

Designed against the cass-memory `PlaybookBullet` model and its ACE-style pipeline, rebuilt
on the titan store kit. It is *not* a port of brain's unused `memory_entries`.
