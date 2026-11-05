---
"@titan-design/fix-proof": patch
"@titan-design/egress-scan": patch
---

`compileGlobs` matches in time linear in the path instead of compiling a backtracking RegExp, so a short glob such as `d/` and twenty `*`, `**/` repeated, or `*a` repeated can no longer hang a fix-proof plan or an egress-scan `.egress-allow` check. Match results are unchanged.
