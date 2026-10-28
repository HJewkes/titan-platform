---
"@titan-design/fix-proof": minor
"@titan-design/test-kit": minor
"@titan-design/review-panel": patch
"@titan-design/autoresearch": patch
"@titan-design/code-graph": patch
"@titan-design/tool-guard": patch
---

The remaining RegExp glob compilers match in time linear in the path (TP-4223). fix-proof exports `LinearRegExp`, also from `@titan-design/fix-proof/linear-regexp`: a RegExp whose `test` simulates its source as an NFA, so a glob such as `d/` and twenty `*`, or `**/` repeated twelve times, can no longer hang a match. review-panel's `matchesGlob`, autoresearch's bounds globs, code-graph's `patternToRegex` and `.gitattributes` patterns, and tool-guard's merge-lint `globToRegExp`, guarded path patterns and glob command words now build one. Each still returns a RegExp and matches what it did, except that a glob too large for V8 to compile, which used to throw at its first test, now matches as written. test-kit exports `linearGrowth`, a growth-ratio ladder that fails a polynomial matcher on a small input before trying a large one, and `hostileGlobs`, the timing rows of tp#2491.
