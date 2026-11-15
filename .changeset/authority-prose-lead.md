---
"@titan-design/review-panel": patch
---

An adversary reply's prose that starts with the word Authority (`**Authority gate.** ...`, `- **Authority check first.** ...`) no longer reads as a malformed Authority line: a line is an Authority label only when a colon follows the label after decoration. A line whose value folds to `widened` still reads widened however it is worded, Authority-led prose that names a widening in any inflection (`**Authority widened.** ...`, `Authority widens: ...`, `**Authority widening.** ...`, `Authority — wider`) reads widened when it starts with it and malformed otherwise, never as no line, and an `authority_missing` correction now quotes the first line that read malformed (TP-6608).
