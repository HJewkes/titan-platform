---
"@titan-design/github": patch
---

The rate budget now tracks GraphQL rate headers apart from core and paces `listReviewComments` against them, and a GraphQL call times out after 30 seconds instead of hanging.
