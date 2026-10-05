---
"@titan-design/tool-guard": patch
---

The shell lexer's spaced-subscript scan now skips `$( )`, backtick spans and `${ }` holding a `]`, so `Y[ $(echo ]) ]=x git push origin HEAD:main` keeps the assignment as one word and the push is still classified. An unterminated span falls back to the plain split.

A `$( )` or backtick span that holds a `[` is scanned character by character as before, since a nested subscript there can hold a closing `)` the scan cannot match.

A `[` in a `${ }` body is scanned the same way, since bash honours a nested subscript there.
