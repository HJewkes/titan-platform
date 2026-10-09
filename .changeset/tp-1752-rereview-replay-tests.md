---
"@titan-design/factory": patch
---

The head and thaw sweeps no longer cancel a conflict, escalation or route gate that asks about the same head as the run's last MRG-AU or seat decision. Such a gate is answered by `conflictGate` without a recorded cancel, so the cancel failed the run. A decision now reads as the gate's only when the prompt names its policy table (TP-1752).
