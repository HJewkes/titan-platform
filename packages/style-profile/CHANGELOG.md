# @titan-design/style-profile

## 0.1.0

### Minor Changes

- 39f1512: New package, ported unchanged from codewatch's `@codewatch/profile` (TP-131). A zod schema
  for a code-style profile, profile read, write and migration, and exporters that turn one
  profile into `eslint.config.js`, `ruff.toml`, `.editorconfig`, a markdown style guide,
  Claude rules, Claude hooks, and a Claude skill rendered from the Handlebars templates
  shipped in `templates/`.
