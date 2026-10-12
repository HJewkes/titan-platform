---
"@titan-design/tool-guard": patch
---

Read `#` and `<<` inside a `NAME[ … ]` subscript that bash may join but the guard splits as word text, so a comment there can no longer hide a following `git push` (TP-2443).
