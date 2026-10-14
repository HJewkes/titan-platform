---
"@titan-design/graph-layout": minor
---

`packageOf` gives each `products/<name>` and `apps/<name>` its own package instead of one `products` or `apps` package, so `collapseToPackages`, `focusPackage` and `packagesInSnapshot` split them too. Export `packageOf`, and add `labelBoxSizing(labels, metrics)`, which sizes boxes to their labels so a collapsed level can be laid out at the size it is shown (TP-2816).
