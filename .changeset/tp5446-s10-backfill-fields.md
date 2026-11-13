---
"@titan-design/active-work": minor
---

Add `active-work task backfill-fields --from <labels.jsonl> (--dry-run | --apply)`, a one-off migration that fills empty class, serves, source, done_reason and blocked_on from an inferred-labels file, each marked `field_origin: inferred:<heuristic id>`. It never overwrites a recorded field and skips owner-only initiatives.
