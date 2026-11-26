---
"@titan-design/factory": patch
---

A visual approve-merge gate reaches the owner only when there is something to look at (TP-6776). Before the gate opens,
the `sh-visual-packet` step reads the head's `pr-visual` check run and, for a successful run, the frame count in its
artifact's manifest. A run that concluded failure, timed_out, cancelled or startup_failure, or a success with zero frames,
records `visual-run-empty` with its reason, spawns no packager, and tells the run's seat (`visual-empty` notice); the run
waits for a new head and no owner gate opens. A notice that cannot go out opens the gate with a "Nothing to look at" line.
A pending run, no run, or an unread frame count opens the gate as before.
