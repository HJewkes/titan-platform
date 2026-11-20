---
"@titan-design/review-panel": patch
---

An adversary MERGE refused as `authority_missing` because a prose line starts with the word Authority now quotes that line, and the correction prompt asks the reviewer to reword it so it does not start with Authority. The adversary brief says no other line may start with Authority. The Authority parser is unchanged, so such a line still reads malformed and is never read as unchanged (TP-6608).
