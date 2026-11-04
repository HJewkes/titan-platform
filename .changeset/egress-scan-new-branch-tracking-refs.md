---
"@titan-design/egress-scan": patch
---

A new-branch push no longer trusts local tracking refs. The scan now excludes only commits reachable from the tips the push URL advertises; a forged or stale `refs/remotes/<remote>/*` ref can no longer hide a commit. When the push URL is missing or cannot be listed, a new branch's whole history is scanned.
