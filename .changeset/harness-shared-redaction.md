---
"@titan-design/agent-protocol": minor
"@titan-design/anthropic-account": patch
"@titan-design/openai-account": patch
---

Share one import-free account diagnostic redactor through agent-protocol/redaction, retaining provider compatibility exports and adding short OpenAI key coverage to both. Redact whole JWTs before embedded key substrings to avoid partially redacted tokens. Copy only redacted Error fields without causes/custom fields, preserve explicitly empty stacks, and keep exact transitive purity checks.
