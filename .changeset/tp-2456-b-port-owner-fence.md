---
"@titan-design/factory": patch
---

`service restart` and `service deploy` (rollback included) first clear a `titan-factory serve` that holds the service port from outside the unit or launchd job: identity is proven by its command line, cgroup or job pid and start time, then it gets SIGTERM, 15 s, a start-time re-check and SIGKILL, logged as `fenced pid N`. Any other holder is refused by pid and argv, and nothing is signalled (TP-2456 b).
