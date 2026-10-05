---
"@titan-design/tool-guard": patch
---

Fail closed on a dynamic word in a wrapper's option position. `timeout $O 5 git push` and `sudo $O git push` now read the word as nothing, as an option, and as an option taking the next word, so the wrapped push is still seen.
