---
"@titan-design/daemon": patch
---

Guard every daemon route with a Host allowlist, an Origin allowlist, and a JSON-only body
gate. A `text/plain` POST from a cross-origin page, or a request whose `Host` names a
rebinding attacker, previously reached the registry and ran the command.
