---
"@titan-design/code-graph": patch
---

`gitTreeSource` fixes. A link chain cut short by the 40-hop budget no longer poisons the memo for a shorter chain that shares its tail: resolution is memoized per remaining hop budget, so a 30-link chain still resolves after a 45-link chain was found looping. A tracked symlink's target resolves `..` one component at a time, as a checkout does, so `../gone/../x` dangles when `gone` is absent instead of normalising to `x`. Both sources now hand the indexer a sorted file list, so a snapshot's float metrics (utilization summed across a barrel's shares) are byte-identical whether the files came from `git ls-tree` or a `readdir` walk.
