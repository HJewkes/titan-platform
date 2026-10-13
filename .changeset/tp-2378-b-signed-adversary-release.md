---
"@titan-design/factory": minor
---

TP-2378 b: a `g10-adversary` hold lifts only through the owner-signed `POST /holds/release-proof`. `shepherd release` that would lift it refuses with exit 65 and writes nothing, whatever actor it sends, and `shepherd hold` refuses (exit 65) a re-hold that changes its reviewer. Other classes release as before.
