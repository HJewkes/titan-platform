---
"@titan-design/daemon": patch
---

Gate the daemon's built-in routes. `buildHttpApp` takes a `gate: DaemonAuth` option that runs right after the Host/Origin guard, so `/health`, `/version`, `/events`, `/rpc` and every `mountRoutes` route answer 401 without a credential; it also adds `POST /auth/logout`. The gate answers `/auth/login` itself (`GET`, `HEAD`, `POST`) and 405s every other method there, so a product catch-all can no longer receive them. On a gated app `/rpc` answers 401 rather than call `createContext` with no auth. `authGate` and `mountAuthRoutes` are no longer exported: mounting the gate inside `mountRoutes` or ahead of the guard left routes open. Ungated apps are unchanged.
