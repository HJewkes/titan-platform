---
"@titan-design/factory": minor
---

Shepherd reruns a red PR head's failed Actions jobs once before it wakes the implementer. A check that passes on the rerun wakes no one; one that fails again wakes the implementer once, at the second run. A head gets one rerun in total, shared with the rerun after a fixer exits without pushing, and a replay after a restart rebuilds the count.
