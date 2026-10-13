---
"@titan-design/factory": patch
---

Shepherd records a merge-train shadow at each land-time refresh: the peers a batch sealed at that moment would take (same repo, unheld, on the default branch, waiting on a refresh or the train), the waiting runs it would refuse and why, and a unit-level disjoint verdict between the PR and main's delta. The rows go to a new `shepherd_train_shadow` table (migration 26), and the update itself is unchanged. `shepherd stats` gains a `trainShadow` section with mean and max batch size, merges that landed outside the batch before the run's own merge, and the refresh-red rate.
