---
"titan-console": minor
---

Add `prTaps.prepare` and `prTaps.act`, so the owner closes or merges a PR from the console without an agent's deposit. The act is owner-write only, pins the posted op to the head the prepare read back, and refuses a confirm once the PR's head or read-back moved.
