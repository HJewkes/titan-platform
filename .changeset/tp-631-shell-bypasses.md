---
---

TP-631: tool-guard shell unwraps `coproc NAME { ... }`, skips the value of watch -s, carries piped text through tee, cat, a subshell and `xargs sh -c`, and models printf width, precision and %c. Empty on purpose: tool-guard releases with its first publish in TP-403 S3.
