---
"@titan-design/review-panel": patch
---

Add the optional `ReviewerMessage.synthetic` field: set only for a record the client wrote in the model's place, with the API error it names and the quota reset, read from the record's own fields and never from its text.
