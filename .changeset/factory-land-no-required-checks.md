---
"@titan-design/factory": patch
---

Land a PR on a repo whose default branch requires no status checks. `land-rules` no longer refuses it: `ci-wait`
waits on every GitHub Actions check-run at the head and lands only when there is at least one and all are complete
and green. Zero runs wait and time out, a red run is red, and another app's runs neither count nor block.
