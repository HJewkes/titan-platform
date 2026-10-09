---
"titan-console": patch
---

Give every console command a class: read, deposit or owner-write. An owner-write runs only for the owner's session cookie on the LAN listener, from a peer that is not this machine, and only with `TITAN_CONSOLE_OWNER_WRITES=1`; loopback, a bearer and a same-machine cookie get 403. Its handler receives the session's `issuedAt` as the presence proof. Every existing command is a read.
