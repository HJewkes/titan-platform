---
"@titan-design/tool-guard": patch
---

A group closed by consecutive `}` words hands the text it prints on to a pipe, so `{ { echo git push origin HEAD:main; } } | bash` is denied like a single close.
