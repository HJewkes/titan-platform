# app-paths: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need an app's per-user data, config, cache or log directory (`appDirs`, the env-paths table with no `-nodejs` suffix), or active-work's data root and session graph path as active-work's own CLI resolves them (`activeWorkRoot`, `activeWorkGraphPath`, honouring `ACTIVE_ROOT`). Every function is pure over an injectable `{ env, home, platform }`. To expand `~` in a transcript path, use `expandHome` in session-read; to scan diffs for leaked data-directory paths, use egress-scan.
