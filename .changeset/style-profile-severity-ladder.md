---
"@titan-design/style-profile": minor
---

Add `severityForConfidence`, the one confidence-to-tier ladder, and `toEslintLevel`, which maps the info tier to `"warn"`. The `build*Rule` builders and `toEslintSeverity` no longer emit `"info"`, which ESLint rejects. The ESLint export now writes an info-tier import order as a warning instead of dropping it. The template helpers and Claude rules exporter read the tier thresholds from the profile instead of literal fallbacks.
