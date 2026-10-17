---
"@titan-design/factory": patch
---

Shepherd retargets every open child of a landed stack parent onto the parent's base before cleanup deletes the parent's branch, whether or not the stack restack is on, and cleanup keeps the branch while any open PR is still based on it.
