---
"@titan-design/render-qa": minor
"@titan-design/explainer": patch
---

Resolve's $0 layer build check now holds custom-layer text to qa's low-contrast rule (TP-4525). A layer whose text sits under the ratio its size needs gets one rebuild, told the text, its colour on its ground, the ratio and the fix: the fill's on- text token, such as `var(--color-on-brand-primary)` on `var(--color-brand-primary-solid)`, or a darker fill. The builder doctrine says the same. render-qa's `low-contrast` finding now carries the `need` it was held to and the text and ground colours as drawn (`fg`, `bg`). The resolve stage version moves to p5c2s2f2s2d6.
