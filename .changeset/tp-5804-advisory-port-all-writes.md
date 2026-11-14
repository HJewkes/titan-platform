---
"@titan-design/factory": patch
---

Refuse ensureBranch, putFile, setPrBase, mergeIntoBranch and openPr for an advisory repo, so no branch or PR write of Shepherd's port reaches it. Factory build keeps the unguarded port, so on an advisory repo it still creates its branch and opens a PR for the owner to merge.
