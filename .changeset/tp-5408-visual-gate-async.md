---
"@titan-design/factory": patch
"@titan-design/coordinator": patch
---

Add the live switch `shepherd.visualGate` (`owner` or `async`; absent means `owner`), TP-5408. Under `async` the merge guard's visual-path row records a `visualChanged` fact instead of gating, a visual touch raises no owner sign-off and does not make the risk tier high, and a `visual-gate2` hold or `gate-2-visual` registration is not the owner's hold on the risk tier. The coordinator lists the key as an editable live factory row.
