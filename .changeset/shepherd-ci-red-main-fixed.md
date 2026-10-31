---
"@titan-design/factory": patch
---

Shepherd merges main up for a ci-red head whose red came with a stale merge ref (TP-4650). When the base commit the head's CI ran against has no finished run of a failing check, as when a newer push cancelled it, the base-red decision walks back to the base's last finished run of each one. If each of those failed at the same step with the same failures as the head, and a later base commit is green on them and on every required context, the head is held as a stale base red and update-branch merges main up, with no fixer woken and no repair spent. A cancelled or missing run is never read as the base's red. One run makes at most two such merge-ups before it wakes the fixer, so a busy base cannot merge up a head that stays red forever. The run's own hold and the await-new-head hook read that limit from the same decision, so once it is spent the hook no longer ends the fixer's wait on a main-fixed red.
