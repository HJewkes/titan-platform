---
"@titan-design/render-qa": patch
---

The probe's content check now reads a computed background by function, so `color(display-p3 ...)`, `oklch(...)` and other modern colour spaces no longer count the space name or a percentage as a channel. A fill paints when its alpha is above the same small threshold as before; `rgb` and `rgba` behave as they did.
