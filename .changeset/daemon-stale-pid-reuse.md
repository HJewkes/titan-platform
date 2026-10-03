---
"@titan-design/daemon": patch
---

`startDaemon` no longer refuses to start when the pid file names a live process that is not this daemon. After a reboot the OS can reuse the pid, which crash-looped supervised daemons. A live pid now counts only if it started no later than the pid file was written, or the recorded port answers `/health`; otherwise the file is logged as stale and removed. `StartDaemonOptions` gains an optional `processStartTime` seam.
