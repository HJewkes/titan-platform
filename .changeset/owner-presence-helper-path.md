---
"@titan-design/factory": patch
---

Check the owner-presence helper's path with lstat before each run. The helper and every parent up to `/` must be owned by root or the current user, with no symlink and no group or other write bit; otherwise presence fails closed and stderr names the offending component. A root install at `/usr/local/libexec/titan-factory/owner-presence` is preferred over `native/build` when it exists.
