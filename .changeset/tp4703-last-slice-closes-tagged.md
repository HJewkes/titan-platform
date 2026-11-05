---
"@titan-design/factory": patch
---

A Shepherd run registered with `--last-slice` now closes its task on merge even when the task is tagged `slices` or `multi-slice`, in both `taskClose` modes, noting `closed by Shepherd: last slice <landing> merged`. An `epic` tag or an unlanded plan slice still holds the task open; without the flag the tags hold it as before.
