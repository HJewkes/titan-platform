---
"@titan-design/factory": minor
"@titan-design/coordinator": minor
---

Load is now the only limiter for factory spawns. The spawn gate's `windowMs` and `headroomIntervalMs` default to 0 and reload live, like `load5`. Coordinator's editable fields list both as live factory rows (0 to 3,600,000 ms). `burstMax` meant nothing without a window, so a config that still sets it fails to load with a message saying to remove it. When the gate would admit a review, any asker within the first N of the queue goes, where N is the free review slots the load check also allows. Fixers still sort first, then the oldest intent. A review counts as unabsorbed from the moment it is admitted until the roster shows it running, so a burst can no longer overshoot `buildLoad5`. A queued ask whose PR moved to a new head, or left the open list the PR snapshot already read, leaves the queue at once instead of aging out.
