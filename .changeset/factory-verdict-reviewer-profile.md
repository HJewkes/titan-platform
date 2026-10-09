---
"@titan-design/factory": patch
---

The `sh-await-verdict` step result now records `reviewerProfile`, the profile of the reviewer whose message it accepted, on MERGE and FIX_FIRST alike. Shepherd's own reviewer gets the profile it was spawned with. An external hold reviewer or a seat reviewer gets the profile the agent-chat roster lists for it. When neither source names a profile, the field is left out. Before this change the profile was only added to the in-memory verdict after the step had been recorded, so no stored verdict ever had it.
