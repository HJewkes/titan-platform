---
"@titan-design/factory": patch
"@titan-design/github": patch
---

Land carries an owner's approve-merge approval to a head update-branch moved to only when that head is a clean merge-up
of the approved head: its first parent the approved head, its second on the base branch, and its tree git's clean
merge-tree of the two (TP-6006). A two-parent push with any other tree, or a failed read, asks approve-merge again. The
fake GitHub's update-branch commits now carry that merge tree, and `fake.cleanMergeTree` answers it.
