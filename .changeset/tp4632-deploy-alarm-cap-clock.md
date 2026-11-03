---
"@titan-design/factory": patch
---

The deploy alarm no longer passes the pacer's 90-min cap. While the pacer holds a target the running build lacks, the "origin/main has held a commit" and "a deploy asked for" alarms wait for firstAt plus the cap, and the deploy line in `shepherd status` prints `cap HH:MMZ`. With no held target the 60-min threshold applies as before.
