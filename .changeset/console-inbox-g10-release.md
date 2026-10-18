---
"titan-console": patch
---

Let `inbox.act` release a `g10-review` or `g10-adversary` hold through Shepherd's `shepherd.release`, as `owner-remote:titan-console`. The release is offered whether or not a reviewer MERGE is recorded: `inbox.prepare` reads back the verdicts from the PR's timeline, counts the MERGEs at the live head (two from two reviewers for `g10-adversary`), and when they fall short says so and labels the confirm "Release without a MERGE". Shepherd's refusal of a moved head comes back as `moved`, and a replay as `already`.
