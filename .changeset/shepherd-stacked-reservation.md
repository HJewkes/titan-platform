---
"@titan-design/factory": patch
---

Shepherd's merge order no longer lets a stacked PR's reservation order others. A stacked PR can merge only after its base does, so a main-based PR waiting behind it deadlocked. A reservation now orders others only while its PR is open and based on the repo's default branch, read from the PR's base on each check; once the stacked PR is retargeted to the default branch it orders as before.
