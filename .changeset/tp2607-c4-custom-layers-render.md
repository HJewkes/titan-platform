---
"@titan-design/explainer": minor
---

The render stage now draws custom layers. It bundles each custom beat's layer from the run's `custom-layers` tree into the served page, and the timeline beat names its module. The page imports that module inside `ready()`, so no frame shows the beat blank. A module that is missing or fails to load stops the render, naming the module. QA's occupancy tables now place each layer on the anchors it declares.
