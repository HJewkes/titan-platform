---
"@titan-design/github": patch
---

`fakeGitHub`'s `deleteRef` now closes every open PR based on the deleted branch, as GitHub's API delete does (TP-2962 a).
