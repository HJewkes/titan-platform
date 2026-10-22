---
"titan-console": minor
---

An after-answer round's recommendation can be revealed before answering: `r` or Reveal recommendation fetches it through the new owner-write `rounds.reveal`, which records the reveal in `revealed.json` while `rounds.get` keeps stripping. An answer given while it shows is sent `recommendationSeen: true`, which `rounds.submit` keeps only for a recorded reveal. A shown recommendation now adds the verdict against the owner's pick, its weak point and fallback, and a Recommended badge on its option.
