---
"@titan-design/factory": patch
---

Shepherd supersedes an MRG-AU approve-merge gate whose only unmet conditions were transient (`merge-tree-clean`, `repo-not-frozen`) once the repo is no longer frozen, both in resync and, under `serve`, as soon as a freeze thaws, so the run asks the policy again at the same head.
