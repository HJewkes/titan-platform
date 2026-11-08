---
"@titan-design/factory": patch
---

build-surface no longer counts a report validator that fails for its environment (ENOSPC, EMFILE, a spawn error) as a report rejection. It runs the validator again once without asking the agent for a fix, and stops the slice as an infra failure if it fails again; a real rejection still stops at two.
