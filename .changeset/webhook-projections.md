---
"@titan-design/factory": patch
---

Add the webhook projections (TP-3827): `INGRESS_KINDS` declares which GitHub events and actions the ingress stores, and `projectDelivery` turns one delivery into an event through the CI and repository key derivations, so a webhook row has the same occurrence key as its backstop row. Unlisted events and actions are ignored, and no pull-request title or body text is stored.
