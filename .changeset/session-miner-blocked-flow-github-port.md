---
"@titan-design/session-miner": patch
---

Blocked-flow now reads PR states through the github package's port (`getPr`) instead of a raw `gh api` call; a PR GitHub cannot find is still reported as unknown.
