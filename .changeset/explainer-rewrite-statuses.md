---
"@titan-design/explainer": minor
---

Q-V11 and the rewrite pass read row statuses from `doctrine/writing-check.json` at the script's own length bucket. A report-only or dropped row reports without warning; the rewrite protects gate and warning rows outside its targets (`protectedRows(words)` replaces `PROTECTED_ROWS`), and its beat guard refuses an added "no X".
