---
"titan-console": patch
---

Show a merge-gate round as a Ship view on `#/rounds/<id>`: each changed image as before, after and diff (NEW when it has no before), light and dark renders side by side, images fetched only as they near the viewport and enlarged on a tap. Ship sends `rounds.submit` bound to the question's head sha; Send back sends the other option with the owner's note as its comment; a sent round shows the factory's outcome, or "Waiting for the factory". `rounds.get` gains `ship`, `manifestSha256` and an optional `answer` whose `choice` (merge or send-back) decides whether a resolved gate reads "Merging at <sha7>" or "Sent back: the implementer gets your note"; the new `rounds.frames` read lists each frame's theme and views; a frames@1 record may name an `after` image; `rounds.submit` answers a Ship round whose variants are the PR's images.
