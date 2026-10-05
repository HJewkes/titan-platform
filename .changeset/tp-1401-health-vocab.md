---
"@titan-design/factory": patch
---

Share one cached-probe helper between the /health GitHub and behind-main probes, export `DIRTY_SUFFIX` and `PROBE_PENDING` from build-info, and compare behind-main against the factory's own repo (`unknown` when it has none).
