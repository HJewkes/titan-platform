---
"@titan-design/review-panel": minor
---

The adversary brief asks for an `Authority:` line (`unchanged`, `tightened` or `widened`) above the verdict lines. New `authorityLine(text)` reads every raw line that carries the Authority label, found through session-read's `labelledLineRest` fold so decoration never hides it, and returns the strictest closed value (widened, then malformed, then unchanged, then tightened), or undefined when there is none. `acceptVerdict` refuses an adversary MERGE with an absent or malformed line once as `authority_missing`, and carries the value as `authority` on the accepted MERGE. Exports `AUTHORITY_HEADING`, `authorityLine` and `AuthorityLine`.
