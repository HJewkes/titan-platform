---
"@titan-design/autoresearch": patch
---

Record a failed ar-sync as `ar-sync:<round>.failed` and keep the run going with the snapshot open, so the next round's
sync retries it; a moved ratchet still stops the run. The read model shows each failure as an open sync with `failed`.
