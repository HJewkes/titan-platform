# doctrine

Two registries share this directory, with a pinned data file beside them. Keep them apart.

| Path | What it holds | Loaded by |
|---|---|---|
| `rules.yaml` | The Q-rule registry (`rules/v1`): script-quality rules, `Q-` ids, each with an L0 and/or judge check | `loadRuleRegistry` |
| `craft/<source>.yaml` | The craft doctrine (`doctrine-craft/v1`): every rule id the video-types study (VT §4) lists, one file per source doctrine | `loadDoctrine` |
| `vocabulary.yaml` | The allowed beats, video types, audiences and structures a craft rule may scope to, and the material signals fit predicates read | `loadDoctrine` |
| `evidence.tsv` | A verbatim copy of the narrative evidence ledger (`E##` ids and grades) | `loadDoctrine` |
| `visual-router.json` | A pinned copy of titan-design's visual router; rewrite it with `scripts/pin-visual-router.mjs`, never by hand | `loadVisualRouter` |
| `types/<type>.yaml` | One `type-profile/v1` per video type | `loadProfiles` |
| `audiences/<id>.yaml` | The audience packs a profile allows (`audience-pack/v1`) | `loadProfiles` |
| `structures/<id>.yaml` | One `narrative-structure/v1` per narrative structure a profile may pick | `loadStructures` |
| `beat-systems/<id>.yaml` | One `beat-system/v1` per beat system: an ordered beat pattern a profile plays inside a structure's blocks | `loadBeatSystems` |
| `beats/<type>.yaml` | One `beat-spec/v1` per beat type: the builder's packet, and a ref to its zod slot schema in `src/beat-slots.ts` | `loadBeatSpecs` |
| `style-packs/<id>.yaml` | One `style-pack/v1` per style pack: existing titan-design token names by slot | `loadStylePacks` |
| `style-tokens.json` | The token names of react-ui's `tokens.css`, the file the explainer template imports; rewrite it with `scripts/pin-style-tokens.mjs`, never by hand | `loadStylePacks` |
| `guides/planner/<type>.md` | Generated planner guides; rewrite them with `explainer guide types`, never by hand | `guideForType` |

`checkProfiles(loadProfiles(), loadDoctrine().vocabulary)` and
`checkStructures(loadStructures(), loadDoctrine().vocabulary)` and
`checkBeatSpecs(loadBeatSpecs(), loadDoctrine().vocabulary)` must also return no issues.

## Adding a type profile

Name the file after its `type`, which must be in `vocabulary.yaml`. Each block's beats come from
the vocabulary; a beat a profile needs that is missing there is added as a beat spec first, in a
change of its own. The planner guide indexes every beat the blocks allow from its spec. List in `series.mustVary` every `SERIES_BASE`
field, plus `structure` when the order is `heuristic`. A fixed order lists neither `structure`
nor `chapter-labels` there. Then run `explainer guide types` and commit the regenerated guides.

`checkDoctrine(loadDoctrine(), loadRuleRegistry())` returns every issue in the craft registry; it
must return none.

## Adding a narrative structure

Add the id to `structures` in `vocabulary.yaml` and name the file after it. The fit predicate
reads only names in the vocabulary's `signals`; a new signal is a vocabulary change of its own,
and the material map must compute it: a rule in `src/material-signals.ts`, or a listed gap there. `fit.ask` is the story-structure §4 question the
predicate encodes. Block shares sum to 1. The spine sections are the template the planner fills
for a video that picks the structure. `design-journey`'s spine is the `spine/v1` template, so a
change to its section numbers is a `spine/v1` change. A heuristic profile names the structure as
a macro; its row's `ask` words the question for that type, and the registry's predicate decides.
A rule that applies only to one structure is a `T` rule naming it in `structures`. Then run
`explainer guide types` and commit the regenerated guides.

## Adding a beat system

A beat system is the beat order inside a structure's blocks, never a second structure: the
structure owns the blocks, shares, fit and spine; the system owns which beats play, in what order.
Add the id to `beatSystems` in `vocabulary.yaml` and name the file after it. Every step's beats
come from the vocabulary; `loadBeatSystems` refuses any other name. A step a structure may drop is
`optional: true`. Then bind it in each profile that plays it, under `structure.systems`:

```yaml
systems:
  - { system: cl-order, macro: before-after }
  - { system: journey-of-attempts, macro: bluf, blocks: [segments] }
```

`blocks` scopes a system to part of a macro, as a segment nests inside a larger order. Each
required step must land, in order, in a block that allows one of its beats (`beat-system-order`).
A pattern known only from an abstract, such as Xu's openings or Wei's climaxes, is not a system
until someone reads the paper. Then run `explainer guide types` and commit the regenerated guides.

## Adding a beat spec

Add the name to `beats` in `vocabulary.yaml` and name the file after it. Every vocabulary beat has a
spec, and a builder asking for a beat with none is refused (`beatSpecFor`).

```yaml
schema: beat-spec/v1
type: proof
summary: "The checks that show it holds: failing at base, passing at head."
role: evidence
component: { name: ChecklistBeat, maturity: spike }
slots: proof
speech: { band: code }
durationS: [6, 12, 22]
preset: false
emphasis: { targets: [checks], treatments: [highlight, scale] }
recipe: "Show one to six checks with their result at base and at head. Show proof, do not assert it."
```

- **Slots:** a key of `BEAT_SLOTS` in `src/beat-slots.ts`, the zod schema the builder fills. Two
  specs may share one, as `arch-map` and `zoom` share `map`. `parseBeatSlots` rejects an unknown beat
  and any slot the schema rejects.
- **Component:** the name and maturity from the video components catalogue (`shipped`, `spike`,
  `doc`); `gap` names none.
- **Emphasis:** the mapping contract. `targets` are slot lists whose items carry an `id`; a script
  cue names one of those ids, and an id used twice in one list is rejected. `treatments` are what
  the template may do to the named element. There is no default treatment: the template picks per
  cue, so emphasis does not look the same everywhere.
- **Recipe:** the packet text, 200 words or fewer. `preset: true` marks a template fill that needs
  no model. Beat rules stay in `craft/` as `B` rules naming the beat; the spec does not list them.

Then run `explainer guide types` and commit the regenerated guides.

## Adding a style pack

A pack picks among titan-design tokens the template already loads; it never adds a token or a
value. Name the file after its `id`, and fill every slot with a name from `style-tokens.json`
(without the leading `--`). Each slot takes one family (`SLOT_FAMILIES` in
`src/style-pack-schema.ts`): a colour for `ground`, an ease for `ease`. `grain` is optional.

```yaml
schema: style-pack/v1
id: night-drafting
theme: dark
feel: "The near-black frame ground with strong hairline rules and one cool teal accent."
tokens: { ground: color-background-frame, surface: color-surface-base, text: color-text-primary, ... }
```

- **Our own look.** A pack copies no channel's look; `loadStylePacks` rejects an id or feel that
  names one in `IMITATED_CHANNELS`.
- **Judged on pilots.** There is no stills round (owner Q7 B): packs are variant parameters, kept,
  cut or tweaked after the owner sees rendered pilots.
- **A token the packs need that tokens.css lacks** is a titan-design change, not a pack field.

Then allow it in each profile that may render in it, under `styles.allow`. A profile whose series
must vary `style-pack` allows at least two. `voice` is the profile's band: a Kokoro voice id and
rate that no other profile shares at the same rate.

## Adding a craft rule

A rule lives in the file of its source doctrine: `direction`, `story-structure`, `creator-craft`,
`talks-and-slides`, `visual-information-design`, `explainer-motion-craft`, `skills-and-taste`,
`owner-feedback` or `script-register` (the spoken-register slices of the script-tells study).

```yaml
schema: doctrine-craft/v1
rules:
  - id: dir-C4
    source: { doc: direction, ref: C4 }
    text: "Hold on-screen text at least max(1.5 s, characters / 13)"
    grade: C
    evidence: [E62, E63]
    scope: { layer: U }
    enforcement: [gate]
    stages: [build, qa]
    check: { kind: gate, ref: gate.readingHold, live: false }
```

- **Id:** `<src>-<ref>[.<n>]`, where `<src>` is `dir`, `story`, `creator`, `talks`, `vid`, `motion`,
  `taste` or `owner`, and `<ref>` is the VT §4 id (`dir-P1`, `story-19`, `motion-G4`, `motion-preset-15`);
  an `owner-feedback` rule uses the owner's rule number instead (`owner-FB3`, `owner-FB2.1`), and a
  `script-register` rule uses `register-` and the study's slice id (`register-N6`).
  `.<n>` only splits one source row into several rules that share `source.ref`. Never `Q-`: that
  prefix belongs to `rules.yaml`. The id never carries the layer.
- **Text:** 40 words or fewer, the rule's do and don't condensed. Never change a number.
- **Scope:** the VT §4 layer exactly. `B` names `beats`; `T` names `types`, `audiences` or
  `structures`; `U*` names the profile `param` that supplies its value; `U` and `U*` name no
  beats, types or structures.
  Every name must be in `vocabulary.yaml`.
- **Evidence and grade:** only the `[E##]` citations the source states, with the grade it states.
  A rule that cites evidence states a grade, and that grade must be one of the cited rows' grades.
  Rules outside DIRECTION carry `evidence: []` and no grade.
- **Supersedes:** the rule ids a DIRECTION Appendix B row overrides.

VT §4.1's type codes map to these names:

| Code | Name |
|---|---|
| A | `repo-argument` |
| Tour | `repo-tour` |
| P | `pr-overview` |
| D | `daily-overview` |
| R | `paper-summary` |
| Pub | the audience `public-youtube` |
| repo types | `repo-tour`, `repo-argument`, `repo-comparison`, `repo-delta` |
| decision brief | `decision-brief` |
| plan | `plan-explainer` |

A beat or type name missing from `vocabulary.yaml` is a change of its own: stop and report it
rather than adding it alongside rule data.

## Choosing the enforcement

If a rule can be code, it is not prompt-only (VT §5.1).

| Source says | Enforcement |
|---|---|
| A DIRECTION §4 row whose "Enforced by" names a check that a Q-rule covers | `lint` or `gate` with `check: { kind: qrule, ref: Q-…, live }`, `live` copied from the Q-rule's L0 status |
| A check in `map-lints` | `lint` with `live: true` |
| Any other named check | `lint` or `gate` with `live: false` |
| A duration, ease, opacity or size value | `token`, with `tokens: [{ name, live: false }]` naming the titan-design token, never its value |
| DIRECTION §4 "plan" | `planner` |
| Beat-level prose | `packet` |
| Universal render prose | `base` |
| Taste and contact-sheet items | `human` |

A rule has a `check` exactly when its enforcement lists `lint` or `gate`, and `tokens` exactly
when it lists `token`.

**The leak rule.** A rule is code-enforced when its check is live or all its tokens are live. A
code-enforced rule lists no `planner`, `packet` or `base` enforcement. A rule whose check or tokens
are not live yet keeps its prompt enforcement as the fallback until the code lands.

**Flip `live` only when the check's code merges.** For a `qrule` check, `checkDoctrine` reports
`qrule-live-mismatch` when a Q-rule's L0 status moves; the pull request that implements the Q-rule
also flips the craft rule's `live`.

## Stages

Take stages from the doctrines' own tags: `[outline]` is `plan`; `[script]` is `script`;
`[beat-plan]` is `plan` and `build`; `[pacing]`, layout, diagram, code and visual rules are
`build`, plus `qa` when the rule has a check; motion beat rules are `build`.

## Refreshing evidence.tsv

`evidence.tsv` is a byte-for-byte copy of the narrative evidence ledger. Before a pull request
that adds evidence citations, diff the two and copy the ledger over if it moved; TP-2866 automates
that check.
