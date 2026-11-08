---
"@titan-design/factory": patch
---

Shepherd retries a GitHub read that timed out, with the gh-api-5xx backoff, before it fails a run, and its seat digest now reports a failed run even when a re-register replaced the run before the digest went out.
