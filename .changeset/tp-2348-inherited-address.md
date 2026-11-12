---
"@titan-design/daemon": patch
---

A daemon started on an inherited socket (`listenFd`) now checks the socket's real address after binding and before the pid file is written. A socket listening beyond loopback throws `NonLoopbackBindError` unless `allowUnauthenticatedNonLoopback` is set, and with a `remote` listener configured it throws `RemoteBindError` even then. Before, only the `host` string was checked, which the inherited path never binds.
