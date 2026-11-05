---
"@titan-design/active-work": patch
---

session recover: identify live claude processes on Linux from `/proc/<pid>/cmdline`, since `ps` reports the thread name `MainThread` there.
