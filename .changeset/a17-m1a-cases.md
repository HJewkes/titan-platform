---
"@titan-design/factory": patch
---

The M1a A17 cases for D-M1a-03 and D-M1a-04 now run in both event-source modes under `a17Event`: "a header-less secondary-limit 403 is Unavailable with a 60 s wait" and "an Unavailable read writes no marker and counts no re-drive" drive the bot's `github-api` pool on the reconciler, and "a stale head read moves no epoch" drives the head guard over the feed. The harness feed gains `limit`, `reads` and `head`, keeps its pool state in the factory's pool-state table, and runs the pool on the feed's clock. Test support only; no production code changes.
