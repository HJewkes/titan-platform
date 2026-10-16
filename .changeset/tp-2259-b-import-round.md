---
"titan-console": patch
---

Add `importRound`, the core of `titan-console rounds import`: it copies a review-harness round dir into the rounds dir as `<unit>-r<round>/`. `round.json` and `feedback.json` must pass the parsers the console reads them with, `frames/frames.json` must name the sha256 of that `round.json` and its unit and round, and only the files it lists are copied, each checked against its sha256. A symlink anywhere in the source is refused, and a refusal writes nothing. A new round is staged in a dot-named dir and renamed into place, with the rounds dir at 0700 and files at 0600. A re-import of the same bytes adds only what is missing; a changed `round.json` or `frames.json` is refused, and an existing `feedback.json` is never replaced. The frames@1 schema gains optional `unit`, `round` and `manifestSha256`.
