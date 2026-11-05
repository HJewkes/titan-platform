---
"@titan-design/factory": patch
---

Shepherd's codewatch questions are anchor-checked at the PR head (TP-2784). `codewatchReader` takes an optional `HeadLines` port; each question's `path:N[-M]` prefix becomes `head/<path>#L<N>[-L<M>]` and is kept only when `verifyAnchorText` finds those lines at the head. A missing path, a range past EOF, line 0 or a `..` path is dropped, and `evidence.anchorDrops` records the first three refusals. At most `MAX_ANCHOR_CHECKS` (10) anchors are checked. A head that cannot be read, or a reader with no `HeadLines`, keeps no questions and warns.
