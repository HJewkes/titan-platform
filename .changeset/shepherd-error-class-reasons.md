---
"@titan-design/factory": patch
---

Shepherd records an error class or HTTP status, never the error's message, in the wake, main-red, post-merge, redeploy, cleanup, resync and Version Packages reasons. `service install` and `service restart` name the serve error log on a failed health check instead of quoting it, so a post-merge chore that runs `service deploy` stores no error text.
