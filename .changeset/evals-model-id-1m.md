---
"@titan-design/evals": patch
---

Accept an exact model id with a final `[1m]` suffix, so a 1M-context variant can be registered. Vertex (`@`) and Bedrock (`:`) id forms are accepted too; bare aliases, mixed case, spaces and `-latest` are still refused.
