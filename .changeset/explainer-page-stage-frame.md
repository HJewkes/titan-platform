---
"@titan-design/explainer": minor
---

The composition page gets the stage frame the doctrine beat kinds will draw in (TP-4276 P1): a chrome of headline,
source line and `n/of` chapter, read from new optional `timeline.json` beat fields (`headline`, `chips`, `chapter`,
`reveals`, `hints`); a stage box whose content throws when it overflows; and the spike's beat CSS. The registry is keyed
by doctrine spec type, its views get `reveal` and `hints`, and `held` is the first stage kind. A test fences every spec
type a shipped profile can emit as registered or on a `NOT_DRAWN` list with reasons. `pnpm --filter
@titan-design/explainer page:sheet` writes a first and a settled screenshot of each kind in `fixtures/kinds.timeline.json`
and tiles them into one sheet. `hook` and `catalogue` render exactly as before.
