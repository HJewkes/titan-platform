---
"@titan-design/factory": patch
---

Turn merge order on for titan-platform (TP-4098 slice C). A conflicted Shepherd run now reserves the paths it changes, lets overlapping runs already in their merge step land first, then gets one conflict wake at the base they leave. Overlapping runs that reach their merge step later wait behind the reservation until the conflicted PR lands. The reservation is released when the run ends.
