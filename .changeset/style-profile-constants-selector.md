---
"@titan-design/style-profile": minor
---

`buildNamingConvention` now scopes the `constants` naming rule to top-level `const` declarations (typescript-eslint `modifiers: ["const", "global"]`) instead of the bare `variable` selector it shared with `variables`. Previously, whichever of `variables`/`constants` happened to iterate last in the profile's naming object silently won for every variable, because typescript-eslint applies the last matching selector; a `constants` rule could shadow the `variables` rule for all variables, or vice versa, depending on key order. The two rules now coexist regardless of profile key order.
