---
"@titan-design/factory": patch
---

Adds the webhook ingress listener on serve (TP-3830, TP-3100 S3): a second loopback listener on 127.0.0.1:7411 that answers only `POST /ingress/github` through `answerDelivery`. It reads the kill switch on each request, so a config edit to `sources: webhook, ingress: on` applies to the next delivery with no restart. It reads the webhook secret file lazily and re-reads it on change, and it cuts a stalled sender at the request timeout. A bind failure is logged once and shown in `health.ingress`, and serve keeps running. Until the S2 projections land, every known event answers 202 and writes nothing.
