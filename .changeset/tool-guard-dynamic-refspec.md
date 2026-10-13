---
"@titan-design/tool-guard": patch
---

A `git push` refspec known only at run time (`git push origin "$X"`, `HEAD:$B`), or an unquoted dynamic push argument that may split into one (`-o $O`), now counts as a push to an unknown protected branch (TP-2702 c).
