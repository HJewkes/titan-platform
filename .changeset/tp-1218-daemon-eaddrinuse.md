---
"@titan-design/daemon": minor
---

`startDaemon` now rejects when the server fails to bind instead of raising an uncaught exception. A port already in use rejects with the new exported `DaemonPortInUseError` (carrying `port` and `host`); other bind errors such as `EACCES` reject with the original error.
