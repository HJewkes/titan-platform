---
"@titan-design/tool-guard": patch
---

`refBranch` reads a gh placeholder in a ref field as a branch known only at run time unless the text before it pins a non-heads ref: `ref=refs/{branch}` and `ref=refs/he{branch}` can fill to `refs/heads/main`, so they no longer read as a non-heads ref.
