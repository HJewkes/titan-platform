---
"titan-console": minor
---

Keep an unsent Ship round's answers across a reload (TP-3870). A Ship round now uses the same localStorage draft as question and design rounds, bound to the manifest sha. The draft holds side-question answers and comments, frame feedback, the round feedback, the Addressed ticks, follow-up marks, and each PR's held Ship or Send back with its note. A changed sha drops the draft with "Draft from an older version discarded", a send clears it, and a sent round never restores one. Drafts saved before this change, which have no Ship part, still restore.
