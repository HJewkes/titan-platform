---
"@titan-design/factory": patch
---

A Shepherd reviewer whose final message passes every identity check but holds no readable verdict block now gets one correction turn in its own session: the new `sh-correct-verdict` step resumes the exited reviewer with the correction prompt, and the reply is read as `sh-await-verdict:<head>:corrected`. A second malformed reply, or a reviewer that cannot be resumed, still goes to a fresh reviewer.
