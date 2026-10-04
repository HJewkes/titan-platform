---
"@titan-design/factory": patch
---

Shepherd waits out a machine hold without escalating. A broker refusal coded `machine_hold` is a `ReviewerMachineHold`, and the time it holds is spent from its own 3 hour ceiling (`DEFAULT_HOLD_WAIT_MS`) instead of the 30 minute busy wait. The wait note reads "held by the machine stop".
