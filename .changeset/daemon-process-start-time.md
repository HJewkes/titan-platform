---
"@titan-design/daemon": minor
"@titan-design/factory": patch
---

`@titan-design/daemon` exports `getProcessStartTime(pid)`, which reads when a process started from `ps -o lstart=` in the C locale, or null when the pid has no process.

`titan-factory service check` no longer reports a crash loop right after `service restart` or `launchctl kickstart -k`: a process under 5 minutes old whose `/health` body names the launchd pid is healthy, even though launchd recorded the killed run's non-zero exit. It reads process start time through the daemon helper instead of its own `ps` parser.
