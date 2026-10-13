# l1-protos: architecture-map legibility study (scratch)

Prototype code for a design study, not a package. It renders several capped views of this repo's package
graph as true 1920x1080 frames, measures them in a headless browser, and renders one level-transition clip.
It reads the graph at runtime and commits no graph data.

```
pnpm build                                              # graph-layout and code-graph dist
node tools/l1-protos/snapshot.mjs "$TMPDIR/graph.json"  # index once (minutes)
node tools/l1-protos/inventory.mjs "$TMPDIR/graph.json" # boundary rules and their element counts
node tools/l1-protos/build.mjs "$TMPDIR/graph.json" <outDir> <dir with playwright-core installed> <chromium binary>
```

Every px value is derived from `frame-config.json` (frames, font metrics, label floor as a fraction of frame height,
safe area, spacing in em, stroke minimums, cognitive ceilings). `L1_FRAME=<name>` picks a frame (default `1080p`),
`L1_FRAME_CONFIG=<file>` another config, and `L1_LABEL_PX=<n>` overrides the derived floor (the older size-comparison
path: `sizes.mjs`, same arguments as `build.mjs`, renders D2-D5 at 24, 32 and 40 px). `L1_CLIP=0` skips the transition clip.

```
node --test "tools/l1-protos/*.test.mjs"                                                # derived limits, rules, placement
node tools/l1-protos/matrix.mjs <graph.json> <outDir> <playwright-core dir> [chromium]  # D2-D5 across every frame
node tools/l1-protos/determinism.mjs <graph.json> <reportDir> <playwright-core dir> [chromium]  # render twice, compare hashes
```

`L1_THEME=plain|dark|light` picks the stylesheet (default plain, the original look). `dark` and `light` inline the
real `tokens.css` of the `@titan-design/react-ui` that `apps/codewatch` depends on, titan's self-hosted heading and body
faces (`theme/fonts`, latin subsets copied from titan-design 408de648, OFL), and `theme/diagram.css`, which maps every
map role to a token. Areas carry a `tone` (their rank, first six only) for the categorical palette; layout never reads
it. Labels then draw in Space Grotesk, so the floor derives from `themeFonts.titan` in `frame-config.json`
(x-height 0.500: 44 px at 1080 instead of 40); the advance and line pitch stay the layout budget. `theme-compare.mjs` (same arguments) renders D2, D4 and D5 at 40 px in all three themes, re-renders the clip in
dark and light, and measures the label faces' x-height and advance.

`L1_MODEL_ORDER=0` lays out each view cold instead of seeding it from the previous view's reading order.

| File | What |
|---|---|
| `frame-config.json`, `lib/config.mjs` | the frame-config schema and the derived limits: label floor, content area, px metrics, grid and lane capacity, caps, top-k bounds |
| `lib/rules.mjs` | the constraint rules a frame must pass (label floor, overlap, edge through label, pills clear, containment, safe area, spacing, crossings, elisions counted, caps, stroke, stability) |
| `matrix.mjs`, `determinism.mjs` | the frame matrix page, and the render-twice hash comparison |
| `lib/graph.mjs` | snapshot → source files, packages (tier from `.codewatch/check.json`, manifest, role counts), package edges |
| `lib/boundaries.mjs` | candidate group rules (tier, name prefix, Louvain, layering) and their counts |
| `lib/model.mjs` | areas (Louvain at low resolution), interest score, edge aggregation |
| `lib/elk.mjs` | elkjs wrapper with per-node options and absolute coordinates |
| `lib/bands.mjs`, `lib/designs.mjs`, `lib/focus*.mjs` | the designs (D1 tier bands, D2 areas, D3 expand in place, D4 area focus, D5 package focus) |
| `lib/labels.mjs` | count pills placed clear of boxes, labels, borders and other edges; container headers moved clear of edges; label/edge crossing count |
| `lib/player.js`, `lib/page.mjs` | SVG page at the frame size with a pinned font, scale reference, staged tween player, DOM measurement and SVG export |
| `sizes.mjs` | label-floor comparison: D2-D5 at 24 / 32 / 40 px, `index.html` + one PNG per design and size |
| `lib/theme.mjs`, `theme/`, `lib/tones.mjs` | stylesheets per `L1_THEME`, titan role map and fonts, per-area tone |
| `theme-compare.mjs`, `lib/font-metrics.mjs` | plain / titan dark / titan light comparison page, label-face metrics |
| `lib/frames.mjs`, `lib/capture.mjs`, `lib/index-page.mjs` | frames and clip timeline, headless capture and MP4, index |
