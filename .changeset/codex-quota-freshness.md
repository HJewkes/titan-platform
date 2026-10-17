---
"@titan-design/openai-account": patch
---

Refuse quota admission from native rollout timestamps: cached token_count re-emissions do not establish a fresh server observation. Valid raw rollout evidence now returns unknown/freshness-unverified without an age; caller-established known readings retain the existing quota policy.
