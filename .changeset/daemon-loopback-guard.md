---
"@titan-design/daemon": patch
---

`startDaemon` now throws `NonLoopbackBindError` before binding when `host` is not loopback (127.0.0.0/8, `::1`, `::ffff:127.x.y.z`, `localhost`), because the daemon has no auth. The explicit `allowUnauthenticatedNonLoopback: true` option lifts the check; no environment variable does. `isLoopbackHost` is exported.
