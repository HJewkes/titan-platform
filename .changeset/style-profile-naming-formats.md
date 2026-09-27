---
"@titan-design/style-profile": minor
---

Map profile naming values to typescript-eslint's naming-convention formats (UPPER_SNAKE_CASE and SCREAMING_SNAKE become UPPER_CASE) so the generated rule no longer makes ESLint reject its config. A naming value with no typescript-eslint format is left out of the rule and reported by the new `buildNamingConvention(profile)` as a skipped rule with a reason; `buildNamingConventionRule` keeps its signature. Also exports `toTsEslintFormat`.
