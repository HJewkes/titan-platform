---
"@titan-design/factory": patch
---

`titan-factory serve` adopts the listening socket systemd passes (`LISTEN_FDS`/`LISTEN_PID`) instead of binding its port, so a restart leaves connections queued rather than refused. `FactoryServerOptions.listenFd` carries it to the daemon, whose start line names `listenFd` when it is used. With no socket passed, serve binds 7410 as before (TP-2348).
