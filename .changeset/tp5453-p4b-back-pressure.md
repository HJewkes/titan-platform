---
"@titan-design/factory": patch
"@titan-design/coordinator": minor
---

`titan-factory dispatch eligible` now opens with the lane's back-pressure admission (TP-5453 P4b, PROPOSAL 2.3): admit or hold, with closed hold codes (`lane-open-prs`, `merged-not-deployed`, `owner-queue`, `reviewer-limit`, `dependency-stalled`, `signal-unreadable`) and the numbers behind each, the task that would go first, and the lane's task inflow against outflow. It reads only. The limits are `shepherd.backPressure.laneOpenPrs` (3), `ownerQueue` (10, counted over the Shepherd gates `shepherd waiting` lists as waiting on the owner) and `inflowWeeks` (2); an absent key means that starting value. The coordinator adds the three as live editable factory rows.
