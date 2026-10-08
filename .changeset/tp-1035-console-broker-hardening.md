---
"titan-console": patch
---

Harden the agent-chat broker client. It no longer follows a redirect, so the token header stays on the broker's own origin. A body that is not JSON or does not match the schema fails as "agent-chat broker <route> answered an unexpected shape" with exit 70, which is how the active-work client already reports drift. A `ui.token` that group or others can access is refused with exit 78 until it is mode 600.
