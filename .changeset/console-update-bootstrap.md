---
"titan-console": patch
---

The console update now runs from a small fixed bootstrap (`deploy/titan-console-bootstrap.mts`) (TP-4043). It fetches, builds origin/main into `releases/<sha>`, and hands off to that build's own `self-update --apply <sha>`, so a fix to the updater applies on the pass that builds it instead of being judged by the installed copy. The updater keeps the previous release until the new one answers `/health` with its sha within 60 s, rolls back otherwise, and files the owner-queue alarm through `alarm.ts`. The bootstrap's build and hand-off failures file the alarm through the serving build's new `self-update --report`. A bare `self-update`, which the timer unit from before this change runs, runs the serving release's copy of the bootstrap, so that unit migrates with no owner step; copying the bootstrap outside the app is optional hardening.
