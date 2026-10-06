---
"@titan-design/style-checker": patch
---

The ESLint generator drops its local `"info"`-to-`"warn"` patch, since style-profile's builders no longer emit `"info"`. Profile-diff deviations take their tier from style-profile's `severityForConfidence`.
