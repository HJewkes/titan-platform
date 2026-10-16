---
"@titan-design/factory": patch
---

Shepherd: a held run woken by a red head reruns that head's failed jobs once, sharing the once-per-head rerun budget with unheld runs, before it tells the seat and waits. A head the rerun turns green is reviewed with the hold kept, so a held red head no longer waits on someone else's rerun (TP-2836). The seat notice for a head still red says Shepherd's one rerun is spent. A run recorded before this change replays its old path.
