---
"@titan-design/factory": patch
---

`service check` and `service status` probe `/health` with a 6 s timeout instead of the daemon's 500 ms default, so a loaded serve is no longer reported as a stale pid.
