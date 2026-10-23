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
  are open kebab-case strings. The type profiles exist (`loadProfiles`), but the schema does not
  check `video_type` against them yet, and beat specs will validate beat types in a later slice.
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
- The profile fields are optional, so a legacy script still parses. A beat's visual may give its
  `layer` (`template` or `custom`), its `framing` (`FRAMINGS`), the 6×6 grid cells it uses
  (`anchors`, `A1` to `F6`) and a `scene`. A cue's `target` is an element id the beat's emphasis
  mapping resolves, and `untilCue` ends the spoken span it covers.
- `structure` records the structure registry name the script was planned under, and
  `parseScript(raw, structures?)` throws `UnknownStructureError` for a name the registry lacks.
  `explainer eval l0` and `explainer run` parse through it, and the script stage records
  `design-journey`, the structure its spine template comes from.
- `signature_layer` (`kind` and its source fact ids) is a hypothesis the pilots measure. It is
  optional, and no check requires it.
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

## The doctrine registry

`doctrine/craft/<source>.yaml` holds the craft doctrine (`doctrine-craft/v1`): every rule id the
video-types study lists from DIRECTION and the six craft doctrines, one file per source. It is a
separate registry from the Q-rules in `doctrine/rules.yaml`, and its ids never start `Q-`.

Each rule sits on two axes:

- **Scope:** layer `U` (every type and beat), `U*` (universal, with a value a type profile
  supplies through `param`), `B` (named `beats`) or `T` (named `types`, `audiences` or
  `structures`). The allowed names are in `doctrine/vocabulary.yaml`.
- **Enforcement:** `token`, `component`, `lint`, `gate`, `planner`, `packet`, `base` or `human`,
  plus the pipeline `stages` that load it (`gather` through `publish`). A `lint` or `gate` rule
  has a `check`; a `token` rule names titan-design `tokens`, never their values.

`loadDoctrine(dir?)` reads the craft files with `vocabulary.yaml` and `evidence.tsv` (a copy of
the narrative evidence ledger) and throws on a shape error, naming the file and rule id.
`checkDoctrine(registry, loadRuleRegistry())` returns every other issue as a coded
`DoctrineIssue`: a missing evidence id, a grade the cited rows do not state, a scope that breaks
its layer, an unknown vocabulary name, a duplicate id, an unresolved `supersedes`, and a `qrule`
check that names no Q-rule or whose `live` disagrees with the Q-rule's L0 status.

**The leak rule.** `isCodeEnforced` is true for a rule whose check is live, or whose tokens are
all live. Such a rule must not list `planner`, `packet` or `base`, because what code enforces
never goes into a prompt. A rule whose check is not live yet keeps its prompt enforcement as the
fallback. Tracked by TP-2745.

**Stage slices.** `sliceForStage(registry, loadRuleRegistry(), { stage, type?, audience?, structure?, beats? })`
returns the rules one pipeline stage loads, each list sorted by id. A `T` rule matches when its
`types` include `type`, its `audiences` include `audience` or its `structures` include
`structure`; a `B` rule matches the requested `beats`.

| Stage | What it returns |
| --- | --- |
| `gather`, `select` | Nothing: these stages load no prose |
| `plan` | `prompt`: `U`, `U*` and matching `T` rules with `planner` enforcement |
| `script` | `prompt`: `U`, `U*`, matching `T` and requested-beat `B` rules |
| `build` | `base`: `U` and `U*` rules with `base`; `packet`: requested-beat `B` rules with `packet`; `tokens` |
| `render` | `tokens` only |
| `qa` | `checks`: every rule with a check, live or not |
| `publish` | `prompt`: matching rules with `human` or `planner` enforcement |

Every slice also lists the `params` its `U*` rules need from the type profile. Only rules that
list the stage in `stages` are considered. No code-enforced rule lands in `prompt`, `base` or
`packet`, and a `qrule` check whose Q-rule's L0 is implemented counts as code-enforced even when
its `live` flag lags. `findPromptLeaks(text, registry, qRules)` checks finished prompt text: it
returns each code-enforced doctrine rule, and each Q-rule whose L0 is implemented, that the text
names by id, alias or exact rule text. Token names are not leaks.

## Type profiles

`doctrine/types/<type>.yaml` holds one `type-profile/v1` per video type: `repo-tour` (the
`explain-repo` default, `EXPLAIN_REPO_DEFAULT_TYPE`), `repo-argument`, `pr-overview`,
`paper-summary` and `daily-overview`. `doctrine/audiences/<id>.yaml` holds the `owner-internal`
and `public-youtube` packs. A profile states its family, intent, audiences, inputs, runtime band,
structure, cuts, hook and ending, series fields, audition size, layer shares, variety and pacing
values, coverage and publish checks. It has no spend cap, since cost is tracked rather than
capped, and no signature-layer requirement.

- `loadProfiles(dir?)` reads those directories and `doctrine/structures/`, and throws on a shape
  error, naming the file.
  `profileFor(set, type)` throws `UnknownProfileError` for a type with no profile.
- `checkProfiles(set, vocabulary)` returns coded `ProfileIssue`s:
  - names missing from the vocabulary, or audiences with no pack;
  - a default audience outside `allow`;
  - dangling macro or block refs, or a macro with no registered structure;
  - a runtime band out of order;
  - a series field in both `mayRepeat` and `mustVary`;
  - a `mustVary` missing a `SERIES_BASE` field;
  - a fixed order that varies its structure or chapter labels, or a heuristic order that does
    not vary its structure;
  - a publishable audience with no per-video owner ask, or a paper profile without the
    `PAPER_PUBLISH_CHECKS`.
- `chapterOrder(profile, { signals, runtimeS? }, structures)` gives one video's block order. A
  `fixed` structure ignores the material. A `heuristic` one takes the first row whose registered
  structure `fits` the material, as story-structure §4 asks its questions, and otherwise the
  fallback (`fallback: true`).
- `guideForType(type)` renders a type's planner guide: the profile, each structure it may pick
  with its spine sections and the rules scoped to that structure, then the `plan` slice for the
  type and its default audience, then a beat index of every beat its blocks allow (role, duration
  range and purpose, from the beat specs). `explainer guide types` writes every guide to
  `doctrine/guides/planner/<type>.md`, and `explainer guide plan --type <type>` prints one.
  A test fails when a checked-in guide differs from its profile. Tracked by TP-2746.

## Narrative structures

`doctrine/structures/<id>.yaml` holds one `narrative-structure/v1` per structure a profile may
pick: `design-journey`, `scqa`, `scqa-c4`, `mystery`, `three-act`, `abt`, `kishotenketsu`,
`countdown`, `attempt-journey`, `review-saga`, `before-after`, `lab-report`, `timeline`,
`board-walk` and `bluf`. Each states its source, a fit predicate over the material map's signals
(`all`, `any`, `none`, and optional runtime bounds, with the question it encodes), blocks with
airtime shares, a hook, an ending and its own spine sections. The agent picks the structure for
each video and the runner-up goes in the render notes; there is no owner pick.

- `loadStructures(dir?)` reads the registry; `structureFor(structures, id)` throws
  `UnknownStructureError` for an unregistered id.
- `fits(structure, { signals, runtimeS })` evaluates the fit predicate.
- `checkStructures(structures, vocabulary)` returns coded `StructureIssue`s: a structure missing
  from the vocabulary or a vocabulary structure with no file, a fit signal missing from the
  vocabulary's `signals`, block shares that do not sum to 1, a runtime minimum above its maximum,
  and a block listed twice.
- `renderSpine(structure)` renders the structure's spine as a fillable template. `design-journey`
  is the owner's journey (owner-FB1, now scoped to it): its spine is the `spine/v1` template, and
  `explainer guide plan` prints it. Tracked by TP-4006.

## Beat specs

`doctrine/beats/<type>.yaml` holds one `beat-spec/v1` per vocabulary beat, including the review
and briefing beats `verdict-card`, `change-group`, `diff-map`, `finding-card`, `proof`,
`frame-flow`, `replot`, `sim`, `rule-diff`, `kanban-flow`, `gantt`, `forecast`, `history-why`,
`attempt` and `companion-link`. A spec gives the beat's purpose and role, its component and that
component's maturity, a slot schema ref, the speech band, a `[min, default, max]` duration, the
packet recipe (200 words or fewer), whether it is a no-model preset, and its emphasis contract.

- `BEAT_SLOTS` holds the zod slot schema each spec's `slots` names.
- The emphasis contract lists the slot lists whose item ids a script cue may target and the
  treatments (`pointer`, `highlight`, `trace`, `scale`, `colour`, `camera`) the template may use.
  There is no default treatment and no separate pointer layer.
- `loadBeatSpecs(dir?)` reads the registry and throws on a shape error, naming the file.
  `beatSpecFor(specs, type)` throws `UnknownBeatError` for a beat with no spec.
- `parseBeatSlots(specs, type, slots)` validates one beat's slots. It throws `BeatSlotError` for a
  slot the schema rejects or for an emphasis element id used twice. `emphasisTargets(spec, slots)`
  lists the ids a cue may name, and `cueElement(spec, slots, target)` throws `BeatSlotError`
  unless the target names exactly one of them.
- `checkBeatSpecs(specs, vocabulary)` returns coded `BeatIssue`s:
  - a spec missing from the vocabulary, or a vocabulary beat with no spec;
  - a slots ref with no schema;
  - a duration out of order;
  - a recipe over 200 words;
  - an emphasis target that is not a list of elements with ids.

Tracked by TP-2867.
