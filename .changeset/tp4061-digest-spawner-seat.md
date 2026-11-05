---
"@titan-design/factory": patch
---

When a run's registrant is no longer live, its seat digest now goes to the first live seat up the registrant's spawned-by chain. That chain is read from the agent-chat roster. Only when no seat in the chain is live does the digest fall back to the repo's seat and, after it, the red seat, red seat fallback and hub seat, as before. That digest counts as the owner's, so the 24 h reroute window does not apply. When the roster can't be read, digests go by repo seat as before, and the sweep now logs why.
