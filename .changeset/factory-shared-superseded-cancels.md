---
"@titan-design/factory": patch
---

land-ci, main-verdict and the coordinator evidence read now use the shared `withoutSupersededCancels` from `@titan-design/github`; the local copies and the freeze re-export are gone. Behaviour is unchanged.
