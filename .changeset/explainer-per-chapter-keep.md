---
"@titan-design/explainer": minor
---

Keep or revert each chapter of a rewrite round on its own (TP-3817 S9). Chapters are tried in order of their solo distance drop, each on top of the chapters already kept, and a chapter is kept only if it fails no more target rows, comes closer to band, fails no more error rows and turns no green protected row (contractions, colon reveals, not-x tails, semicolons, let's) red. `RoundReport.chapters` names the row each reverted chapter turned red; `chapterRefusal`, `PROTECTED_ROWS`, `ChapterVerdict` and `ChapterRefusal` are exported, and `roundRefusal` is gone.
