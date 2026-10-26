---
"@titan-design/decider": minor
---

Match decide thresholds on the normalized category. `minConfidenceFor` looked up `policy.categories` by the raw category, so "Tech Design" missed the `tech_design` row and fell back to the 0.8 default. It now matches rows on the same key as `categoryPolicy` and takes the strictest threshold when several spellings match. New `decidePolicyFrom(routingPolicy)` builds the `DecidePolicy` that `validate` reads from a `RoutingPolicy`.
