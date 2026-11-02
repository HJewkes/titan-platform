---
"@titan-design/factory": patch
---

Add marker validity (TP-3107 S3): `evaluateFact` checks material inputs first, then the pin, TTL expiry and version, and compares each input's projection digest, never its pin, so an equal projection stops the cascade. A changed full output under an equal projection is reported as drift and leaves the fact valid. `readMarkerValues` now returns the surviving reads beside the names of the missing ones.
