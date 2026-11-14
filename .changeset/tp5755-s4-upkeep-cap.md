---
"@titan-design/factory": minor
---

Add the dispatcher shadow's upkeep cap (TP-5755 S4): the share of upkeep files among all files the lane's PRs changed in the last `upkeep.windowDays` (7), classed by the checked-in `eligibility/upkeep-paths.json`. At `upkeep.capShare` (0.25) or more, `upkeep-cap` holds tasks tagged `class: upkeep` and untagged tasks whose bet serves one of `upkeep.factoryOutcomes`; product tasks are never held. Changed paths come from `gh api` reads cached in `<shadow.dir>/../cache/pr-files.json`; an unread share holds upkeep tasks.
