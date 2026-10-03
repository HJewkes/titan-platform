---
"@titan-design/factory": patch
---

Shepherd watch rows now read as stalled when a run stays in `ci`, `fixing`, `review` or `merging` past that phase's limit, measured from the phase start. Phases that wait on a person or an agent never stall on time.
