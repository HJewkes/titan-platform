---
"@titan-design/daemon": patch
---

Answer a throwing `/mcp` handler with a JSON `errorEnvelope` (status 500, code `EXIT.SOFTWARE`) instead of a bare `String(err)` body.
