---
"@titan-design/factory": patch
---

Count Shepherd's review wait deadline and exit grace from the reviewer session's start (the dispatch time when no start is recorded), so a restart no longer gives a review a fresh 30 minutes. A restart 25 minutes after the reviewer started leaves it 5 minutes; a reviewer already exited past its grace ends the wait at once. A detached reviewer keeps its 10-minute grace from first sight.
