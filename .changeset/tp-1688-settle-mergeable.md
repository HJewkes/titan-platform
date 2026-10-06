---
"@titan-design/factory": patch
---

Shepherd's merge evidence re-reads a PR whose `mergeable_state` is `unknown` (at most 3 reads, 5 s apart) before judging merge-tree-clean, records the judged state in the evidence record, and gates with `mergeable_state unknown after 3 reads` when it never settles.
