---
"@titan-design/factory": patch
---

Shepherd's PR evidence comment no longer posts the reviewer transcript's hostname or absolute path. It carries the session id, record offset, part position and a hash of the full locator; the stored record keeps the whole locator.
