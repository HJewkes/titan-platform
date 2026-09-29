# @titan-design/style-profile

## 0.3.0

### Minor Changes

- 8003e54: `buildNamingConvention` now scopes the `constants` naming rule to top-level `const` declarations (typescript-eslint `modifiers: ["const", "global"]`) instead of the bare `variable` selector it shared with `variables`. Previously, whichever of `variables`/`constants` happened to iterate last in the profile's naming object silently won for every variable, because typescript-eslint applies the last matching selector; a `constants` rule could shadow the `variables` rule for all variables, or vice versa, depending on key order. The two rules now coexist regardless of profile key order.

## 0.2.0

### Minor Changes

- 89da3cf: Map profile naming values to typescript-eslint's naming-convention formats (UPPER_SNAKE_CASE and SCREAMING_SNAKE become UPPER_CASE) so the generated rule no longer makes ESLint reject its config. A naming value with no typescript-eslint format is left out of the rule and reported by the new `buildNamingConvention(profile)` as a skipped rule with a reason; `buildNamingConventionRule` keeps its signature. Also exports `toTsEslintFormat`.

## 0.1.0

### Minor Changes

- 39f1512: New package, ported unchanged from codewatch's `@codewatch/profile` (TP-131). A zod schema
  for a code-style profile, profile read, write and migration, and exporters that turn one
  profile into `eslint.config.js`, `ruff.toml`, `.editorconfig`, a markdown style guide,
  Claude rules, Claude hooks, and a Claude skill rendered from the Handlebars templates
  shipped in `templates/`.
