---
"@titan-design/openai-account": patch
---

Refuse native quota startup when the canonical temporary workspace has any Git or Codex project-config ancestor, or when ancestry metadata is unreadable. This guards TMPDIR inside a checkout without reading configuration contents or changing account-home authority; it remains a preflight check rather than filesystem-race isolation.
