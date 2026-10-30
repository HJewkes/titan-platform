---
"@titan-design/factory": patch
---

Wait only on runs busy when a restart drain began, so steps admitted during the drain cannot stretch it. A busy park-routed step still holds the restart.
