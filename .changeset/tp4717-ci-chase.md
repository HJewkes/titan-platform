---
"@titan-design/factory": patch
---

Shepherd no longer chases main's tip with a green PR. When main's delta shares a unit with a green head whose base moved, Shepherd now reserves merge order for the PR's units before update-branch, so later PRs in those units wait at their merge and the PR lands on its next green. A merge-order entry ending in `/` covers every non-markdown path in that unit. The disjoint check still runs at every green read, so a rerun's green lands as it stands when main moved since only by disjoint commits.
