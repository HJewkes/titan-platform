---
"@titan-design/explainer": patch
---

The built CLI finds the composition page sources (TP-4302). `compositionPage` used to look for them two levels above its own module, which is right for `src/render/` but points outside the package from a tsup chunk in `dist/`. It now finds the package root by the nearest `package.json` named `@titan-design/explainer`, through the new `pageSourceFrom(dir)`.
