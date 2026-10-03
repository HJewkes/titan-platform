---
"@titan-design/factory": patch
---

Shepherd: a new head pushed while an `sh-sent-back` gate is pending now resumes the run. The head sweep cancels the gate
as superseded, and the run awaits the new head and reviews it, with no owner answer. Before, the gate waited on the owner
even after an implementer's successor had pushed the fix.
