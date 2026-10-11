---
"@titan-design/coordinator": minor
---

Add `resolveSeatPolicy`: a seat's effective hard stops and scorer defaults. A seat may override a charter default through the new seat `defaults` key, and its `kind_weights` and `share_caps` merge key by key. A seat can only add hard stops and only lower `stop_short_factor`, so a global hard stop is never removed.
