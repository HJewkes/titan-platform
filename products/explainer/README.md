# @titan-design/explainer

Explainer video pipeline: beats.json and digest.json schemas, packet builder, finding attribution

Tier product of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Private, never published. This slice holds only pure code: file schemas and the two helpers
the build and repair steps share. Gather, plan, audio, assembly, render and the CLI land in
later slices.

| File | Contract |
|---|---|
| `beats.json` | `StoryboardSchema`: `video_type`, `title`, `chapters`, `beats` |
| `digest.json` | `DigestSchema`: a `since`/`until` window of items with stable ids |
| `lexicon.json` | `LexiconSchema`: written term to spoken form |

`video_type` and each beat's `type` are open kebab-case strings on purpose. Their allowed
values come from a doctrine registry planned at `products/explainer/doctrine/` (one profile
per video type, such as `repo-tour` or `repo-argument`, and one spec per beat type), which
will validate a storyboard against them. Until that lands, any kebab-case value parses.

`beats.json` has no version field. A format change adds an optional field or a migration;
the zod shape is what validates a file.
