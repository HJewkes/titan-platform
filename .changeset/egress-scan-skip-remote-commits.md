---
"@titan-design/egress-scan": patch
---

Pre-push no longer re-scans commits the remote already has when a branch merged main: the range for a known remote sha now also excludes every commit reachable from the remote's refs.
