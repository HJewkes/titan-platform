---
"titan-console": minor
---

Show a Ship round's lineage before the owner taps Ship: the proven-at sha, merged or UNMERGED, the PR base's tip and how many base commits the proven head lacks, with a stale head marked. `rounds.get` carries it as `lineage`, read from GitHub and cached per binding for a minute; anything unread shows "lineage unknown" with its reason.
