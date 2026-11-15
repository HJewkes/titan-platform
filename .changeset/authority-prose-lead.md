---
"@titan-design/review-panel": patch
---

An adversary reply's prose that starts with the word Authority (`**Authority gate.** ...`, `- **Authority check first.** ...`) no longer reads as a malformed Authority line: a line is an Authority label only when a colon follows the label after decoration. A line whose value folds to `widened` still reads widened however it is worded, and an `authority_missing` correction now quotes the first line that read malformed (TP-6608).
