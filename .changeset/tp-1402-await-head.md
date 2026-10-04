---
"@titan-design/factory": patch
---

The await-new-head step now fails at once on a 401, 403 or 404 read of the pull request, naming it and the status, instead of retrying a permanent error forever. Transient read failures are still retried and are reported through `onReadError`.
