---
"@titan-design/tool-guard": patch
---

The xargs option readers no longer read a word an option takes as its value as an option of its
own: `xargs --max-args -0 git push origin` is not read as NUL-separated input, and `-E -n2` is not
a batch size. The reading the guard had before is kept beside the new one, so no verdict loosens.
