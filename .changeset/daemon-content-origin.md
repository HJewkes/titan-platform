---
"@titan-design/daemon": minor
---

`startDaemon` takes `contentOrigin: { port, mountRoutes }`: a read-only origin on its own port for untrusted content, such as a built Storybook shown in an iframe. It serves only the product's routes, answers every method but GET and HEAD with 405, and has no `/rpc`, `/events`, `/health`, `/mcp` or `/auth/*`. It binds loopback and, with `remote`, the remote address behind the same TLS pair, port-bound Host check and auth gate, so the main listener's session cookie authenticates there with no sign-in route of its own. Every listener binds or none does; `handle.contentPort` reports the port. The new `containedFile(root, pathname)` resolves a URL path to a real file under a root chosen per request, refusing `..`, encoded separators and symlinks that leave the root, and returns the file's content type for `fileResponse`.
