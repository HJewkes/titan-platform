---
"titan-console": patch
---

Add the coordinator config store: an append-only revision log under `<state>/config/`, a materializer that writes the head document to titan-coordinator's config dir by temp file, fsync and rename, a shadow import of an autonomy tree that must round-trip through `renderSeatBook`, the `config.compareTree` read, and `titan-console config import` / `config compare-tree` for the owner's one-time rev 0. The compared tree is the one `TITAN_CONSOLE_AUTONOMY_DIR` names, the same tree `config.surfaces` reads.
