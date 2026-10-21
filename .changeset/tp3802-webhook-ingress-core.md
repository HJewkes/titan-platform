---
"@titan-design/factory": patch
---

Adds the webhook ingress core (TP-3802, TP-3100 S1): `answerDelivery` verifies `X-Hub-Signature-256` over the raw body, answers 404 before reading the body or the secret unless the effective GitHub sources mode is webhook, and appends at most one `source='webhook'` row keyed `webhook:<delivery>`. Nothing binds a port or calls it yet.
