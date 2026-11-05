---
"@titan-design/factory": patch
---

Remove `confirmOwner`, the owner-presence mode that returned the helper's bare proof id. Nothing called it once `gate resolve` and `shepherd owner-release` moved to signed statements; owner presence now only runs the helper's `pubkey --id` and `sign`. The helper path checks are unchanged and are tested through `signStatement`.
