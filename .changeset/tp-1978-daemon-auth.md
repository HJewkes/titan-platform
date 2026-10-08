---
"@titan-design/daemon": minor
---

Add session, login-code and bearer auth for a listener beyond loopback. New exports: `ensureTokenFile`, `rotateTokenFile`, `TokenFileError`, `mintLoginCode`, `consumeLoginCode`, `createLoginCodeLedger`, `signSession`, `verifySession`, `createDaemonAuth`, `authGate`, `mountAuthRoutes`, `getRequestAuth`, the constants `SESSION_COOKIE`, `LOGIN_PATH`, `LOGOUT_PATH`, `LOGIN_CODE_TTL_MS` and `SESSION_MAX_AGE_MS`, and the types `DaemonAuth`, `DaemonAuthOptions`, `LoginCodeLedger`, `RequestAuth` and `TokenFileProblem`. Login is two steps: `GET /auth/login?code=` renders an inert page, and its same-origin JSON `POST /auth/login` spends the code and sets the cookie. `createContext` now receives what the gate recorded as an optional second argument; nothing is gated by default, so loopback behaviour is unchanged.
