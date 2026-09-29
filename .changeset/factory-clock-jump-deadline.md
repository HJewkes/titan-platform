---
"@titan-design/factory": patch
---

Make the `ci-wait` and `update-branch` step deadlines survive a clock jump: a sleep that overruns by more than a minute defers expiry to one fresh poll at least two minutes after the wake.
