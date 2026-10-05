---
"@titan-design/factory": patch
---

Owner presence now fails closed, naming the error code on stderr, when lstat of the root helper path or a parent fails with anything other than ENOENT or ENOTDIR, instead of treating it as absent and falling back to native/build.
