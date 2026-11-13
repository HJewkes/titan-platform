---
"@titan-design/review-panel": patch
"@titan-design/factory": patch
---

A MERGE whose final message only repeats its verdict block now reads its Attests and Follow-ups lines from the reviewer's
latest earlier full verdict at the same head in the same session; CI-policy, Authority and Probes stay read from the final
message alone. The Attests heading is matched through session-read's `labelledLineRest`, so a bolded or bulleted heading
is read, and the reviewer brief asks for checkout cleanup before the final message.
