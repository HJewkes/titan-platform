---
"@titan-design/factory": patch
---

`titan-factory shepherd register` tells a refused connection from a serve that is busy: it waits up to 20 s (two tries) for `/health` before exiting 69, and the message says whether the connection was refused or the serve did not answer. Serve logs a `shepherd.register` that took longer than 5 s.
