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

`L1_MODEL_ORDER=0` lays out each view cold instead of seeding it from the previous view's reading order.

| File | What |
|---|---|
| `lib/graph.mjs` | snapshot → source files, packages (tier from `.codewatch/check.json`, manifest, role counts), package edges |
| `lib/boundaries.mjs` | candidate group rules (tier, name prefix, Louvain, layering) and their counts |
| `lib/model.mjs` | areas (Louvain at low resolution), interest score, edge aggregation |
| `lib/elk.mjs` | elkjs wrapper with per-node options and absolute coordinates |
| `lib/bands.mjs`, `lib/designs.mjs`, `lib/focus*.mjs` | the designs (D1 tier bands, D2 areas, D3 expand in place, D4 area focus, D5 package focus) |
| `lib/labels.mjs` | count pills placed clear of boxes and labels; label/edge crossing count |
| `lib/player.js`, `lib/page.mjs` | 1920x1080 SVG page with scale reference, staged tween player, DOM measurement |
| `lib/frames.mjs`, `lib/capture.mjs`, `lib/index-page.mjs` | frames and clip timeline, headless capture and MP4, index |
