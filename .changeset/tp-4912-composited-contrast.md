---
"@titan-design/render-qa": minor
"@titan-design/explainer": patch
---

render-qa's `low-contrast` rule scores text against its composited ground: translucent background colours up the
ancestor walk are blended down to the first opaque paint, and a linear or radial gradient under the text is sampled
under the run's box, the worst sample scored. Text over paint the walk cannot model (a background image, a filter, a
blend mode, a backdrop filter) is a new non-gating `contrast-unmeasured` finding with a `reason`, never a ratio
against the page background. explainer's qa contrast report lists those runs as `text.unmeasured`, and the
`text-contrast` check names them apart from its pass or fail.
