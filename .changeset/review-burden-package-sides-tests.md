---
"@titan-design/review-burden": patch
---

The merge-base lookup now pipes stderr like the manifest read, so a failure prints only the skip warning. Adds tests for the renamed-manifest base path and the merge-base failure path.
