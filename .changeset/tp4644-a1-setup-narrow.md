---
"@titan-design/active-work": patch
---

Read caught errors in the setup steps through the rpc-protocol narrowing helpers instead of `err as` casts. A thrown non-Error now prints as `String(err)`.
