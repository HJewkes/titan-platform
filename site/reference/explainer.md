# explainer

**Product.** Private, never published. No titan dependencies yet; it depends on `zod`.

```sh
pnpm build
```

## The problem it solves

An explainer video is built in steps: gather what happened, plan a storyboard of beats,
build each beat with a model, check the render, repair the failing beats. Each step hands
the next a file, and each repair has to reach the worker that built the failing beat.

This first slice adds the file contracts and the two pure helpers every later step shares:

- `StoryboardSchema` for `beats.json`, `DigestSchema` for `digest.json` and `LexiconSchema`
  for `lexicon.json`.
- `buildPacket`, which builds one beat builder's packet: the beat, its component API, its
  resolved sources and the lexicon entries its text mentions.
- `attributeFindings`, which maps gate findings to the beat each one names.

## When to reach for it

Use it inside the explainer pipeline. Reach for `@titan-design/react-ui` for motion
primitives and beat components, and for [`evidence`](/reference/evidence) to verify a code
citation before its excerpt reaches a packet.

## Example

```ts
import { StoryboardSchema, attributeFindings, buildPacket } from "@titan-design/explainer";

const board = StoryboardSchema.parse(JSON.parse(beatsJson));
const packets = board.beats.map((beat) =>
  buildPacket({
    beat,
    videoType: board.video_type,
    catalog: new Map([["stat", "Stat({ value, label })"]]),
    sources: new Map([["src-1", { id: "src-1", kind: "text", text: "Twelve PRs merged." }]]),
  }),
);

const { byBeat, unattributed } = attributeFindings(findings, board.beats.map((b) => b.id));
```

Verified against 0.0.0.

## What it deliberately does not do

- It does not know which video types or beat types exist. `video_type` and a beat's `type`
  are open kebab-case strings; a doctrine registry (type profiles such as `repo-tour` and
  `repo-argument`, beat specs) will validate them in a later slice.
- It reads and writes no files and makes no model or network calls.
- It does not verify citations. The route step does that before it resolves a source.

## Gotchas

- `buildPacket` throws rather than returning an error: on a code beat (type `code` or
  `code-*`) with no non-blank code excerpt, on a source id it was not given, on a beat type
  missing from the catalog, and on a packet over `maxBytes` (default 48,000).
- `attributeFindings` matches whole ids by number: `beat-03` and `beat-3` name the same beat,
  and `beat-3` never matches `beat-30`. Only `error` findings are attributed; ones naming no
  known beat come back in `unattributed`.
- `beats.json` has no version field. A format change adds an optional field or a migration.
- A beat's `stops` are seconds from the beat start, ascending, and no later than its
  `duration_s`.

## Where it came from

New. The packet byte cap and the code-excerpt rule follow a HyperFrames skill's packet
builder; `attributeFindings` ports a demo-video script's helper of the same name, minus its
substring match, which sent `beat-3` findings to `beat-30`. Tracked by TP-2611.

## The map track

A beat's `visual.map_state` declares what the repo map shows: its level, camera, revealed
boxes, edges, focus, cards and pins, each change keyed to a spoken cue. `map_state` is
optional. A beat without it takes the map off screen, so a video can cut to another slide
type and come back.

- `MapBeatSchema`, `VisualSchema` and `MapStateSchema` parse the visual track;
  `MapLayoutSchema` is the slice of the layout the lints read.
- `lintMapBeats(beats, layout)` returns errors for a jump of more than one level, more than
  `MAX_NEW_BOXES` (3) new boxes in a beat, more than `MAX_FULL_WEIGHT` (7) boxes at full
  weight, an id the layout lacks, a drawn edge with no `edgeSource`, a `hand` layout without
  an `our-framing` chip, and two cards entering on one cue. A zoom with no later map beat is
  only a warning.
- `message_in_flight` walks a flow from `fromHop` to `toHop`, inclusive. `lintMapBeats`
  rejects `hopCues` whose count is not one per hop (`flow-hops`), and a speed-3 walk with no
  earlier speed-1 walk of the same flow over the same hops (`flow-replay`).
- `lintMapCues(beats, resolveCue)` reads word timings. It rejects a hop cue that leaves less
  than a `HOP_DWELL_S` (0.8 s) dwell plus `HOP_MIN_TRAVEL_S` (0.5 s) of travel before the next
  hop cue or the beat's end, divided by the walk's speed, or that comes before the walk starts
  (`hop-fit`). It also rejects an `untilCue` that does not come after the walk's `atCue`
  (`until-cue`). Travel is checked against its floor; the renderer re-checks real routes.
- `compileMapTimeline(beats, resolveCue)` returns one segment per map beat, in seconds from
  the video start, with sorted events. `cueResolverFromWords` builds the resolver from
  per-beat word timings and throws on a cue the beat never speaks.
- `toDiagramMapTimeline(timeline, { layoutSha, cameraBox })` converts the segments into
  titan-design's `MapTimeline`: the layout sha, the merged on-screen spans, and keyframes
  sorted by time, op and ids. It adds a `level` and a `minimap` keyframe at a segment's start
  when either changes. A flow keyframe carries the walk's hop and until cues as `hopAtS` and
  `untilAtS`. `cameraBox` turns a beat's camera target into a layout box; a camera move
  without it throws. `DiagramMapTimelineSchema` mirrors titan-design's type strictly. A test
  checks it against a copy of titan-design's fixture, so drift fails a test instead of a render.
- `placeTimelinePins(timeline, beats, resolveCue, layout)` adds `pins` to each segment: every
  pin's time, anchor, text and placed `box`, from graph-layout's `placePills` against the
  scene `layout.sceneFor(beatId)` returns, above `CAPTION_KEEP_OUT`. The painter draws a pill
  at its box. A pin with no clear spot, or in a beat with no scene, gets `box: null` and the
  painter falls back to an offset from its anchor.

A beat that re-enters the map resumes the last map beat's camera, revealed boxes, focus and
active set, and its own fields override them. Level checks and the new-box count run against
that resumed state, so leaving the map never resets them.

## Camera stations

`cameraStation(beatId, layout, focusIds)` frames a beat's focus boxes for the camera. It
returns the union of the boxes, padded by `DEFAULT_PADDING`, then widened to 16:9 and grown
so the content sits inside the top `CAPTION_KEEP_OUT` (83 %) of the frame, where captions
never cover it. `cameraStationFile` gives the `camera/<beat>.json` path and its JSON. Focus
ids are sorted and deduplicated, so the file does not depend on their order. `projectBox`
maps a layout box into 0..1 frame fractions. An unknown focus id throws. The module writes
no files; the CLI step that lands later writes them.

## The two-track script

`ScriptSchema` parses `script/v1`: video-level framing (audience, stake, promise, thesis),
chapters, and beats that each carry a narration track and a visual track. The visual track's
`map_state` is `MapStateSchema` unchanged, so a script beat with no `map_state` is off the map
and the next map beat resumes it.

- Every cue in a beat's visual track, map ops and off-map `cues` alike, must name a word the
  beat speaks (`word` or `word#n`). Beat ids are unique, each beat's chapter exists, and
  `thesis_refs` name beats.
- Required authored fields accept a `TODO:` placeholder, so a draft parses and the lints
  report every gap at once.
- `deriveEvalView(script, layout?)` returns the view judges and lints read: `nodes_shown`,
  `edges_shown`, `you_are_here` (the camera station, else the focus) and `state_changes`
  ordered by where their cue is spoken. It is derived, never authored.
- `toMapBeats(script)` projects a script onto `MapBeat[]`, so `lintMapBeats` and
  `compileMapTimeline` run on it.
- `migrateTourV0(tour, probe)` lifts a spike tour and its render probe to v1. It infers each
  beat's function, mode and visual job from the spike's component kind and rebuilds the
  headline, labels, chips and map stations from the probe's last shot. Tracked by TP-2806.

## The Q-rule registry

`doctrine/rules.yaml` holds the script-quality rules (`rules/v1`), shipped with the package.
`explainer eval l0` stamps every row with its sha, and uses it when `--rules` is omitted.

- Each rule has a `Q-` id, the script fields it reads, its phase-1 `aliases` and `related`
  ids, and `owner_support` (`none`, `for` or `against`), updated from owner sessions.
- Its `l0` check is `implemented` with the check ids it emits, or `pending` on an owning
  slice; its `judge` check is `cited` by a rubric file, or `pending`. The check type (`L0`,
  `J`, `L0+J`) is whichever of the two it has.
- `loadRuleRegistry(path?)` and `parseRuleRegistry(text)` validate it; an id or alias that
  names two rules fails. `resolveRule` maps a Q-id or alias to its rule, and
  `unimplementedL0Rules(registry, emittedIds)` lists rules whose claimed check ids no
  registered check emits. Tracked by TP-2811.
