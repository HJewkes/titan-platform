---
"titan-console": patch
---

The theater's video sidecar parser accepts an optional `explainer` block (video id, up to 50 run ids, profile, script sha, and an opaque fingerprint up to 32 KB). A larger or malformed block still counts as an unreadable sidecar; sidecars without it parse unchanged.
