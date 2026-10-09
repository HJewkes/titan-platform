---
"@titan-design/daemon": minor
---

Add an authenticated remote listener. `startDaemon` takes `remote: { host, tokenFile, allowedHosts? }` and opens a second listener on that address and the same port. The loopback listener is unchanged. On the remote listener the Host/Origin guard and then the auth gate run before every route, Host and Origin match only with the bound port, and `/mcp` is never served. Both listeners bind or neither does, and `close()` shuts both. A loopback, wildcard or non-IP `remote.host`, or a remote listener beside an unauthenticated non-loopback `host`, throws the new `RemoteBindError`. New guard option `portOnly`. `RequestAuth` gains `peerLocal`, true when the peer is one of this machine's own addresses. New exports: `RemoteBindError` and the type `RemoteListenerOptions`.
