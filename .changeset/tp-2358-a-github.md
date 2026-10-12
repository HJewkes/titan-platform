---
"@titan-design/github": patch
---

`ghCliWire` rejects a pull request whose REST `state` is neither `open` nor `closed`, instead of passing it through where a "not open" check reads it as closed (TP-2358 a).
