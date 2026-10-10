---
"@titan-design/anthropic-account": patch
---

`refreshIfNeeded`'s lock holder record is now created with `O_EXCL | O_NOFOLLOW`, so a symlink at its path is never written through. It is read through the credentials gate (owner, mode, link count, no blocking on a FIFO). A release that throws still frees the lock dirs and no longer turns a `write-failed` result into `io`.
