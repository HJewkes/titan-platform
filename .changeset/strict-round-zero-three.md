---
"titan-console": patch
---

The console reads round.json with a strict copy of review-schema 0.3.0's `RoundSchema` (vendored at 4fcb3827 until the release is on npm, TP-3232). Rounds with `baseImage`, `change`, `decision`, `topics` or `prGroups` now list, open, serve frames and import. A blind-ab round is refused, so no engine reaches the page. A round that only 0.3 reads is a gap in the approvals queue until owner-queue installs 0.3 too.
