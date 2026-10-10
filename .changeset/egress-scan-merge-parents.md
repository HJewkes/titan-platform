---
"@titan-design/egress-scan": patch
---

Stop `pre-push` from flagging a merge commit for content that came in from a parent the remote already has. With the push URL listed, a two-parent merge is diffed against a re-merge of its parents, so a conflict resolution or evil merge is still scanned. When the remote cannot be listed, every parent is diffed as before.
