---
"@titan-design/factory": patch
---

The host entry points now pass `hostCarryPorts` to tree-carry explicitly: head-lines, git-pr-files, the release carry read in the shepherd commands, the adversary and hold carry reads in the workflows, and land-pr's merge-tree read (TP-4827). Behaviour is unchanged.
