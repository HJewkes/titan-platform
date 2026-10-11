---
"@titan-design/factory": patch
---

The Shepherd ci-red wake counts the failing check runs and, for the known CI jobs (validate, lint-types, dag-check, egress-scan), names the scripts that reproduce each and asks the implementer to rerun them before pushing, as the brief's test rule says. Check-run names stay inside the fenced CI log and never reach the instruction text.
