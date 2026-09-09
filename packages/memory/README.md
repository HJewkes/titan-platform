# @titan-design/memory

A decaying rule playbook for coding agents: what worked, what did not, with the
confidence of each rule derived from an append-only feedback log. The data model and
math follow cass-memory's `PlaybookBullet` and its ACE-style pipeline, rebuilt on the
titan-platform store kit so a playbook shares one SQLite file with the session graph
that produces its evidence.

Tier 2 of the titan-platform DAG. Depends on `store-sqlite`, `embed`, and `retrieval`.
Designed against active-work AW-31 (TP-13); not a port of brain's unused `memory_entries`.

```ts
import { PlaybookStore, curate, recall, memoryMigration } from "@titan-design/memory";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";

const db = openDatabase("state.sqlite3");
runMigrations(db, [memoryMigration(1)]);
const store = new PlaybookStore(db);

// Zero-LLM path: the agent that just learned something writes it down.
curate(store, [{ type: "add", content: "Pin npm to 11 in release jobs", tags: ["ci"] }], {
  provenance: { sessionRef: "session:abc", byteOffset: 4096 },
});

// Before the next task: what does the playbook say about this?
const { bullets, antiPatterns, deprecatedWarnings, degraded } = await recall(store, "release job npm");
```

## Model

- **Bullet**: content, category, tags, scope, type (`rule` | `anti-pattern`), kind, source,
  state (`draft` | `active` | `retired`), maturity (`candidate` | `established` | `proven` |
  `deprecated`), pinned, half-life, provenance (`{ sessionRef, byteOffset }`).
- **Feedback** is an immutable log of `helpful` / `harmful` events. Counts and scores are
  computed at read time, so changing the decay parameters re-scores history for free.
- **Storage** is the kit: bullets are interval entities, `supersedes` is an edge,
  embeddings live in `cache_blob` keyed by content hash, per-session progress is a watermark.

## Scoring (`scoring.ts`)

```
decayedValue(event)  = 0.5 ^ (ageDays / halfLifeDays)        halfLifeDays = 90 by default
effectiveScore       = (decayedHelpful - 4 * decayedHarmful) * { candidate .5, established 1, proven 1.5, deprecated 0 }
```

Maturity: under three events is a candidate; over 30% harmful is deprecated; ten helpful
with under 10% harmful is proven; otherwise established. Promotion jumps to the earned
rung, demotion drops one rung per pass, a score under -3 deprecates outright, and pinned
bullets never move. Staleness is separate from decay: silence for 180 days flags a bullet
for re-validation.

## Curation (`curate`)

Deterministic, no model involved. Deltas are `add` | `helpful` | `harmful` | `replace` |
`deprecate` | `merge` (zod-validated, `PlaybookDeltaSchema`). The curator:

1. drops duplicate deltas within the batch (one vote per bullet per batch);
2. refuses any `add` near a human-blocked pattern (`store.block`);
3. folds an exact or Jaccard >= 0.85 duplicate `add` into a `helpful` on the existing
   bullet, unless the polarity differs, in which case it is added and flagged as a conflict;
4. applies replacements and merges by adding a successor and retiring the originals with
   `supersedes` edges;
5. inverts a non-pinned rule whose decayed harm is at least 3 and more than twice its
   help into an `AVOID:` anti-pattern;
6. runs the maturity pass.

Provenance is an option on `curate`, never a field on a delta, so a model cannot claim a
source it did not have.

## Recall (`recall`)

```
keywordScore   = 3 per exact token + 1 per substring + 5 per tag match
relevanceScore = keyword * (1 - w) + similarity * w      w = 0.6 when a semantic index is supplied
finalScore     = relevanceScore * max(0.1, effectiveScore)
```

Filtered on relevance (not final score), so a topical bullet with low confidence still
surfaces, near the bottom. Returns `bullets`, `antiPatterns`, `deprecatedWarnings`, and a
`degraded` list explaining why semantic scoring fell back to keywords, if it did.
`MemoryVectors` builds the semantic index from `cache_blob` with any `Embedder`.

## Reflection (`reflectSession`)

The one stage that may call a model. You supply a `Reflector` that turns a session diary
into proposed deltas; the loop feeds the growing playbook and prior deltas back in for up to
three iterations, stops on nothing new or at 50 deltas, validates every item, then curates
with the session's provenance and advances the watermark. Invalid output is reported in
`rejected`, never thrown.
