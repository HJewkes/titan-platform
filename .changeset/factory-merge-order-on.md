---
"@titan-design/factory": patch
---

Turn merge order on for titan-platform (TP-4098 slice C). A conflicted Shepherd run now reserves the paths it changes, lets overlapping runs already merging land first (a run held in its merge step behind a live reservation does not count, so runs never wait in a ring), then gets one conflict wake at the base they leave. Overlapping runs that reach their merge step later wait behind the reservation until the conflicted PR lands. The reservation is released when the run ends.
