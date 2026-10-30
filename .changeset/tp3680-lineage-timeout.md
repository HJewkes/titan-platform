---
"titan-console": patch
---

Bound the Ship lineage GitHub read to 5 seconds so a stalled GitHub marks lineage unknown ("github timed out") instead of hanging rounds.get (TP-3680).
