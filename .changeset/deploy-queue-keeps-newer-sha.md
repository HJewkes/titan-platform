---
"@titan-design/factory": patch
---

Keep a queued redeploy sha when an older merge whose own main run goes green late is queued after it, instead of letting the older sha overwrite it. When the deploy checkout does not hold either merge yet, the ancestry probe fetches main's objects (no ref moves) and asks again.
