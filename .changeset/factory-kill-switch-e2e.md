---
---

Test the webhook ingress kill switch end to end through serve (TP-3405): a config-file flip moves the route between 404 and 2xx and the reconciler between the polling and backstop intervals, with no restart.
