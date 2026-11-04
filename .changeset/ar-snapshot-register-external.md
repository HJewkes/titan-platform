---
"@titan-design/factory": patch
---

An autoresearch snapshot target can set `register: "external"`. Its cuts open the snapshot PR and book no Shepherd run in the run's own database; each cut logs `[register-external] <repo>#<pr> slice <phase>-m<k>` for an operator to register with the Shepherd that should review it. An in-process run on an isolated database otherwise started a second Shepherd on every snapshot PR. Such a target needs only the host's GitHub port, so `[no-shepherd]` does not apply to it. Absent, `register` keeps today's in-process registration.
