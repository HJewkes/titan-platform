---
"@titan-design/factory": patch
---

The planner window probes no longer drop a merge, red run, resolved gate or ci-failed gate whose time cannot be read. Each prints an "at an unknown time" line, as undatable console rounds already did, so the wake runs the review instead of skipping it.
