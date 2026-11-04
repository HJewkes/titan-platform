---
"@titan-design/github": patch
---

Send REST reads as `gh api -i <path>?<query>` instead of `-X GET` with `-f` fields, so a gh shim can classify them as reads.
