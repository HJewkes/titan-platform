---
"@titan-design/factory": patch
---

Shepherd's seat check reads each seat reviewer's transcript once per roster change instead of once per verdict. A cached read is reused while the reviewer's agent id, session id, presence and the transcript's size and mtime are unchanged; a new session under a name, a presence change, or an appended verdict reads again. A damaged transcript's veto is cached as the same rejection.
