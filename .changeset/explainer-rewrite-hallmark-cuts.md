---
"@titan-design/explainer": minor
---

The rewrite plan directs hallmark-flagged sentences as cuts: `hallmarkHits` lists each naming-refrain, teaser, label-first and colon-tricolon sentence with its beat and row, `BeatDirective.cuts` carries them while the matching hallmark row fails, and the rewrite prompt tells the model to delete each quoted sentence or fold it into a neighbour, never reword it.
