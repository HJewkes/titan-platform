---
"titan-console": patch
---

`config.compareTree` no longer returns an absolute filesystem path: an unexpected fs error on the revision log (EACCES, ENOTDIR and the like) is replaced by `cannot read <path relative to the state dir>: <code>`, and an unreadable tree file or directory names its errno code beside its tree-relative path.
