---
"@titan-design/session-graph": patch
---

`refreshCorpus` expands a leading `~/` (or a bare `~`) in a stored source key before checking whether the file still exists, so transcripts keyed under the home directory no longer flip to missing. A new `homeDir` option overrides the OS home directory.
