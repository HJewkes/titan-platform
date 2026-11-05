---
"@titan-design/agent-dispatch": patch
---

Replace the type assertions in the limits resolver, the limits file readers, the agent row check and the sync exec failure path with runtime narrowing, and parse the resolved limit values with zod. No change for valid input.
