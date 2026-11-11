---
"@titan-design/explainer": patch
---

Add the cue kinds cmd, out and event to CUE_KIND_ROLES, so a script with a typed terminal command, its output lines or a dated timeline event passes the pace layer's cue-kind classifier without stand-in kinds. A draft script whose run, detail or note cue carries a shell command, test or exit output, or a dated event is now rejected, and the retry names the kind to use (TP-4035).
