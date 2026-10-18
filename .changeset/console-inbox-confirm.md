---
"titan-console": patch
---

The inbox page acts: a gate row shows "Approve merge" and an owner-asked hold row "Release hold". The tap opens a confirm sheet that calls `inbox.prepare` and shows the read-back (effect, repo#PR, title, head, how long ago it was read). Confirm stays disabled until that read-back has loaded, then calls `inbox.act` and shows the outcome in the sheet. Cancel sends nothing. When the console cannot act (actions off, owner writes refused, no action, or a snapshot page), the sheet or row shows the terminal command instead.
