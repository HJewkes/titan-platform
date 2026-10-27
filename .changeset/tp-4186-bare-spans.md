---
"@titan-design/tool-guard": patch
---

Record which characters of a spliced word were read outside quotes and escapes (`WordToken.bare`), so `expandsAtRunTime` counts only bare glob, brace, tilde and `=cmd` characters: `query='{viewer{login}}'`, `query='[ID!]'` and `a"*"b` no longer read as expanding, while `query={a,b}`, `'query='*` and `a*"b"` still do. A word whose value is rewritten after lexing counts as bare throughout, as before.
