---
"@titan-design/factory": patch
---

The deploy watch no longer rolls back a build because runs in flight replay-diverged under it (TP-3889). `/health` lists `recoveryReplayDiverged` (runs strict replay parked for the diverged sweep) and `divergedRestarts` (runs the sweep restarted, with a successor that exists). The watch leaves both out of its count and reports them in the deploy output; a run that fails, or parks for any other reason, under the new build still rolls back.
