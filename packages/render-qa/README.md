# @titan-design/render-qa

The render QA gate as a library. It seeks any page that speaks the `__titanMotion` protocol to chosen moments,
measures the DOM at each one, and applies a persistence rule that separates held layout errors from an entrance
passing through. Its one video reader, `frameDiffs`, decodes through ffmpeg; it knows nothing of beats' components,
React or a product's policy.

Tier 2 of the titan-platform DAG. It depends on `@titan-design/frame-capture` (tier 1) and takes `playwright-core`
as a peer, as frame-capture does. The `video-mechanism-no-react:render-qa` rule in `.codewatch/check.json` keeps
React out of `src/`.

**Private.** The package is `"private": true` and is consumed through `workspace:^` only, until a consumer outside
this monorepo needs it. The repo's release rules treat it like any package for versioning and like a product for
publishing: a change under `packages/render-qa` still needs a changeset (`pnpm changeset status` in CI counts it),
and the "Version Packages" pull request bumps its version and writes its CHANGELOG, but `changeset publish` skips a
private package, so nothing reaches npm and no first hand publish or trusted publisher is needed. The docs build
lists it without a reference page, as it does private products. Publishing later means dropping `private`, adding
`publishConfig.access: public` and a reference page, and the one-time hand publish in the root CLAUDE.md.

## Use

```ts
import { launch } from '@titan-design/frame-capture'
import { addLateFill, buildMoments, classify, inspectAt, openQaPage, writeCrops } from '@titan-design/render-qa'

const browser = await launch()
const { page, cues } = await openQaPage(browser, url, undefined, timelineCues) // omit cues to read window.__cueLog
const frames = []
for (const m of buildMoments(beats, cues)) {
  const { contentRuns, findings } = await inspectAt(page, m.t)
  frames.push({ beat: m.beat, local: m.local, t: m.t, kind: m.kind, contentRuns, findings })
}
addLateFill(frames, cues, new Map(beats.map((b) => [b.id, b.durationS])))
const { errors, info } = classify(frames, { gate: gatingKinds }) // the caller's policy; defaults to ERROR_KINDS
await writeCrops(browser, url, errors, cropDir, DEFAULT_OPTIONS)
```

- `buildMoments(beats, cues)`: per beat, its first frame (`start`), 0.3 s in (`enter`), its middle, 0.9 s after each
  cue (cues closer than 0.6 s to a kept moment add nothing) and 0.2 s before its end. Beats run back to back.
- `openQaPage` opens the page through frame-capture's virtual clock and turns on pointer events everywhere, which
  `elementsFromPoint` needs. `inspectAt(page, t)` seeks and inspects; it throws when the page reported an uncaught
  error, because a page whose render threw shows a blank frame that would inspect clean.
- `classify` holds a finding seen in two consecutive samples of a beat, or at the beat's settled `end` moment. One
  transient sample is info. `late-fill` gates on one sample, and so do `double-chrome` and `under-chrome`, the only
  kinds read at the `start` and `enter` moments. A `wrap` gates only when it leaves an orphan.
- `writeCrops` writes an annotated PNG per held error, at most 8 per kind, and sets each error's `crop` file name.

## Sweep, probe and frame change

```ts
import { frameDiffs, probeMoments, sweepMoments } from '@titan-design/render-qa'

const sweep = sweepMoments(beats, { settleBy: (b) => (b.kind === 'outro' ? 1 : 0) }) // the settle rule is policy
const probed = await probeMoments(page, sweep.filter((m) => m.kind === 'end'))
const diffs = await frameDiffs('out/video.mp4') // one share per frame; tests pass an exec in place of ffmpeg
```

- `sweepMoments(beats, { hz = 2, settleBy })`: samples on a grid counted from the video's start, not per beat. Each
  beat's settled sample (kind `end`) is its last one before `end - settleBy(beat)`, or its last when none is; every
  other sample is a `cue` moment, so `classify` treats them as it treats cue moments. It equals the archived
  `sweep_moments.py` (`src/fixtures/sweep/`, a copy of `products/explainer/fixtures/spike/goldens/sweep/`).
- `probeMoments(page, moments)`: per moment, every visible text run (text, font px, tag, class list, one box per
  rendered line, and every ancestor that clips it, painted or not, with the element itself first when it clips) and
  every visible element that holds text or paint, with `decor` set under `data-qa-decor`. Empty layout wrappers are
  left out. The types are render-qa's own; a product adapts them to its checks.
- `frameDiffs(video, exec?)`: each frame decoded to 320x180 grey, as the share of pixels that moved more than 3
  levels since the frame before (frame 0 is 0). Counting pixels, not a mean, is what catches a small element's fade.
  It rejects when ffmpeg fails, so an unreadable video never reads as a still one.

## Finding kinds

`ERROR_KINDS` lists every kind that may gate: `text-overlap`, `text-box`, `box-overlap`, `occluded`, `edge-crossing`,
`off-frame`, `content-overflow`, `small-text`, `low-contrast`, `wrap`, `flex-wrap`, `anchor-offset`, `label-dropped`,
`edge-label-far`, `late-fill`, `double-chrome`, `under-chrome`, `fill-order`, `tone-mismatch`, `title-repeat`,
`unlabelled-number`, `label-adjacent` and `misaligned`. The inspector also reports `ellipsis`, `escapes-box` and
`crowding`, which never gate. Which of the gating kinds a product gates on is its own policy, passed to `classify`.

## The data-qa-* protocol

A page tells the inspector what its layout means with attributes on its own elements.

Exemptions:

| Attribute | Meaning |
| --- | --- |
| `data-qa-container` | A panel other elements sit on by design. Text and boxes inside it do not overlap it; they still overlap each other and anything outside it. |
| `data-qa-context` | Context dimmed on purpose. It and its descendants get no contrast finding. |
| `data-qa-decor` | A marker drawn over a node by design. It takes part in no overlap, occlusion or crossing. |
| `data-qa-camera` | A layer the camera is carrying mid-move. Its geometry is scaled and leaves the frame by design, so it gets no `off-frame` or `edge-label-far` finding. |

Hints for the frame rules:

| Attribute | Meaning |
| --- | --- |
| `data-qa-order="<sel>"` | Its children are cards read in order, and `<sel>` matches a card's rows. A later card showing rows while an earlier one shows none is `fill-order`. |
| `data-qa-title` | A card's title. Its siblings are the card's rows: a row that starts with the title is `title-repeat`, one with digits and no word is `unlabelled-number`. |
| `data-qa-glyph` | The glyph inside a `[data-mark]` or `[data-state]` element whose colour carries the state. A problem state (`problem`, `risk`, or failure words) drawn in `--color-status-success` is `tone-mismatch`. |
| `data-qa-level="<sel>"` | `<sel>` matches values in sibling cards that must sit level; tops more than 4 px apart are `misaligned`. |

Geometry the page declares:

| Attribute | Meaning |
| --- | --- |
| `data-anchor-x`, `data-anchor-y` | Viewport px the element must be centred on, per axis present, within 4 px (`anchor-offset`). |
| `data-edge="<id>"` | Wraps the SVG `path` of edge `<id>`. |
| `data-edge-label="<id>"` | A label that must sit within 60 px of the path inside `[data-edge="<id>"]` (`edge-label-far`). |
| `data-labels-dropped-ids` | Space-separated ids of labels placement could not seat. Each is a `label-dropped` finding: a dropped label is never drawn. |

Class names the default options read: `.xp-chrome` (the chrome; one shown at a time, skipped by crowding),
`.xp-chrome, .xp-legend` (furniture left out of `contentRuns`) and `.xp-band-top, .xp-band-bottom` (bands stage
text must stay out of). Override them through `InspectOptions`.

A page may publish `window.__cueLog`, a `Map` of `{ beat, word, nth, atS }` with `atS` in beat-local seconds; the
session reads it when the caller passes no cues.

## Where it came from

A port of the motion spike's QA gate (`examples/qa/{inspect,held,moments,session}.ts` and the crop writer in
`examples/qa.ts`), its `examples/framediff.ts` and `examples/probe.ts` (extended with line boxes, clips and element
boxes), and the archived `qa/s9/sweep_moments.py` sweep. Two changes are deliberate: `openQaPage` takes `cues` (a composition page has no `__cueLog`), and
`classify` takes the gating kinds. The inspector runs in the page as one serialised step per check, bound to a
shared object at run time, so each check fits this repo's function and file limits and still reaches the others
whatever a bundler renames. `src/fixtures/qa-fixtures.html` is a plain-HTML port of the spike's seeded-defect page:
one bad and one clean twin per check, with synthetic text.
