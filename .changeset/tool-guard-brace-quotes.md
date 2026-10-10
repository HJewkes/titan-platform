---
"@titan-design/tool-guard": patch
---

Match the closing brace of `${…}` and paren of `$((…))` with bash's quoting rules: quotes, escapes, `$'…'` and nested substitutions hide a closer, and an unquoted `{` does not nest. A quoted `}` in a parameter default no longer ends it early and hides the commands after it. A `}` inside a process substitution in `${…}`, which bash 3.2 and bash 5 read differently, is refused.
