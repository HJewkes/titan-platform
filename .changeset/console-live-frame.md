---
"titan-console": minor
---

Show a round's story variants live in the round page (TP-3793 S4). A variant whose `rounds.get` `live.frames` entry has a url renders one iframe per manifest width on the story origin, sandboxed `allow-scripts allow-same-origin allow-forms` with `allow=""`, lazily mounted and fitted to its column. Its captured PNG is the placeholder until the bridge in that frame's own window posts `ready`, and the bridge's `height` sizes it. A story with no `ready` in 10 s, or an `error`, remounts once and then falls back to the PNG with "Live story unavailable" and Retry. At most 4 frames are mounted on a phone and 8 on a desktop. Enlarge live shows the story at 1:1. Ship-bound sections show the PNG first with Open live, and an entry with only a `reason` shows the PNG with that reason. Wired into section strips, question frames and A/B sides; Ship montages stay PNG. A frame in pin mode or holding pins stays its PNG with its pin layer, so pinning works as before.
