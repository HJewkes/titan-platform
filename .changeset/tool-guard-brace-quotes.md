---
"@titan-design/tool-guard": patch
---

Match the closing brace of `${…}` and paren of `$((…))` with bash's quoting rules: quotes, escapes, `$'…'` and nested substitutions hide a closer, and an unquoted `{` does not nest. A quoted `}` in a parameter default no longer ends it early and hides the commands after it. A `$((` whose `)` matching the second `(` is not followed by another `)` is read as a command substitution holding a subshell, as bash does, including in heredoc bodies. Lines bash 3.2 reads differently, a `$( )` inside `${…}` or `$((…))` that paren counting ends elsewhere or a `<( )` inside `${…}` whose text ends the parameter early, are refused.
