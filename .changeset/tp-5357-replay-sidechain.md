---
"@titan-design/session-analytics": patch
---

The cache-TTL reverse replay no longer treats a sidechain request as the previous prompt of a main-chain request. `TtlRequestRow` carries `isSidechain`, and the replay groups by session and chain.
