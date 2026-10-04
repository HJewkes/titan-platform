---
"@titan-design/daemon": patch
---

`startDaemon` no longer refuses to start when the pid file names a live process that is not this daemon. After a reboot the OS can reuse the pid, which crash-looped supervised daemons. A live pid is treated as reused only when its start time is proven later than the pid file's mtime and the recorded port does not answer `/health`; the file is then logged as stale and removed. If the start time cannot be read, startup refuses and keeps the pid file. `StartDaemonOptions` gains an optional `processStartTime` seam.
