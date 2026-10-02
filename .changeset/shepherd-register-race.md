---
"@titan-design/factory": patch
---

`shepherd register` writes its registration in the start hook, so a crash between starting the run and registering it leaves neither, and a concurrent register of the same repo#pr from another process returns the first run instead of starting a second. A repeat register can no longer widen a stored registration's merge mode or fixer.
