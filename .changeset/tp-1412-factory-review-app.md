---
"@titan-design/factory": patch
---

Shepherd's merge facts bind `shepherd/review` to the configured `shepherd.reviewCheck.appId` through `contextApps`, so a required `shepherd/review` passes only on the Shepherd App's success at the head and a GitHub Actions job of that name no longer counts. With no App configured the context has no counting app and gates; every other context still counts from GitHub Actions only.
