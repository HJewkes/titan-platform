---
"@titan-design/daemon": patch
"titan-console": patch
---

The signed-out pages now say how to get a sign-in link: who to ask, that a link works once for ten minutes and dies on restart, that a session lasts 30 days, and that a home-screen app keeps its own cookies. `createDaemonAuth` and `remote` take an optional `signInHint` so a product names its own command; the console passes `titan-console login-link`.
