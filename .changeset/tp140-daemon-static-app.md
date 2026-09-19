---
"@titan-design/daemon": minor
---

Add `mountStaticApp(app, { root, base, immutableDir })` for the `mountRoutes` seam (TP-140). It serves a built front end, or a single-file build, under a path prefix. It sets content types, `nosniff`, immutable caching for hashed assets, and `no-cache` elsewhere. Client routes fall back to `index.html`, and a missing asset gets 404. The page answers 503 until the app is built. Traversal is refused, by encoded segment, by symlink, and for dotfiles. It registers `GET` only, behind the existing guards.
