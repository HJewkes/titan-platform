---
"@titan-design/tool-guard": patch
---

The shell lexer's spaced-subscript scan now skips `$( )`, backtick spans and `${ }` holding a `]`, so `Y[ $(echo ]) ]=x git push origin HEAD:main` keeps the assignment as one word and the push is still classified. An unterminated span falls back to the plain split.
