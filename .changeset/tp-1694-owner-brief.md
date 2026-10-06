---
"@titan-design/factory": minor
---

The Shepherd reviewer brief for a run that will reach the owner asks for an OWNER-BRIEF block (what, why, pros, cons, door type) after the verdict. The reader parses it into a typed `ownerBrief` on the sh-await-verdict output; a missing or malformed block is `null` and never changes the verdict.
