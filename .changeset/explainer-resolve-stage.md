---
"@titan-design/explainer": minor
---

Add the `resolve` stage to `explainer run`, between `eval` and `tts`. It maps each beat's `{function, job, content, route}` through ordered resolver tables to `{beat spec, component, framing, layer, anchors}`. A beat that matches no row is refused with a coded error, and there is no list fallback. Code beats are checked against a `code` artifact with evidence's `verifyRange`, so a line past the end of the file is refused before anything is written. Word budgets are capped per speech band (3.2 / 2.8 / 2.3 / 2.8 words a second, held 1.5) and per profile block. The emphasis-target gate is registered on the stage.
