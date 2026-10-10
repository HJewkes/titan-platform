---
"@titan-design/factory": patch
---

A repeat-safe workflow step that fails with a GitHub server-side error (`gh-api-5xx`) is retried up to three times, after 5 s, 20 s and 60 s, before the run fails. The retries are recorded as `ghRetries` on the step's evidence record, and any other failure class fails at once.
