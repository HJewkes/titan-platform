---
"@titan-design/code-graph": minor
---

Add the context dossier and bundle builders, ported from codewatch's `graph context` with unchanged behavior. `buildContextDossier(input)` projects one file or symbol into a `ContextDossier` (metrics, churn, centrality, ownership, source and test consumers, coupling, blast radius, per-symbol importance), and `renderContextMarkdown(dossier)` renders it as markdown. `buildContextBundle(input)` adds the target's source span, its edges as explicit callers, dependencies and coupling partners (ordered by seeded relevance when `relevanceByFile` is given), and coverage; `renderBundleText(bundle)` concatenates it for an embedder. The dossier's schema version is exported as `CONTEXT_SCHEMA_VERSION`, and the bundle's as `BUNDLE_SCHEMA_VERSION`.
