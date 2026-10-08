---
"@titan-design/chat-protocol": minor
---

Rename the two `agents` schemas that carried a `Schema` suffix to the package's suffix-free convention: `activityCategorySchema` is now `agentActivityCategory` and `nodeActivitySchema` is now `agentGraphNodeActivity`. The bare names stay with the `activityCategory` and `nodeActivity` functions. The `ActivityCategory` and `NodeActivity` types are unchanged.
