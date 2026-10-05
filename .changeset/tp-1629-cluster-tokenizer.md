---
"@titan-design/tool-guard": patch
---

Every wrapper short-option reader (`takesValue`, the xargs replace, batch and delimiter readers) now splits a cluster through one tokenizer, so a digit-led cluster such as `xargs -0I %` is read the same as `xargs -0 -I %`.
