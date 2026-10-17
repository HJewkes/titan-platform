---
"@titan-design/factory": patch
---

Shepherd no longer parks forever when CI at the same head turns green. A cancelled run's reds beside a live or passed run at that head no longer read as red, and a wait for a new head after a ci-red also ends once every required check passes at the unchanged head (a rerun or a late run), so the run goes on to review and land there.
