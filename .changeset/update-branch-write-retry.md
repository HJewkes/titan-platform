---
"@titan-design/github": patch
---

`updateBranch` sends its PUT once more, with the same expected head, after an empty or unparseable answer or a 5xx. A 422 head mismatch on that retry reads as already updated; any other second failure rethrows the first error. gh's "unexpected end of JSON input" now counts as transient for reads too.
