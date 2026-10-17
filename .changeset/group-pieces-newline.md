---
"@titan-design/tool-guard": patch
---

A `{ }` group, `( )` subshell or `< <(...)` now joins its commands' printed text with the newline echo ends each with, per shell, so `{ echo hi; echo git push origin HEAD:main; } | bash` is refused (TP-3332). A `{name}` redirect after `}` or `)` is read as the group's own, so `{ echo git push origin HEAD:main; } {fd}</dev/null | bash` is refused (TP-3334).
