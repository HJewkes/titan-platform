# doctrine

Two registries share this directory, with a pinned data file beside them. Keep them apart.

| Path | What it holds | Loaded by |
|---|---|---|
| `rules.yaml` | The Q-rule registry (`rules/v1`): script-quality rules, `Q-` ids, each with an L0 and/or judge check | `loadRuleRegistry` |
| `craft/<source>.yaml` | The craft doctrine (`doctrine-craft/v1`): every rule id the video-types study (VT §4) lists, one file per source doctrine | `loadDoctrine` |
| `vocabulary.yaml` | The allowed beats, video types and audiences a craft rule may scope to | `loadDoctrine` |
| `evidence.tsv` | A verbatim copy of the narrative evidence ledger (`E##` ids and grades) | `loadDoctrine` |
| `visual-router.json` | A pinned copy of titan-design's visual router; rewrite it with `scripts/pin-visual-router.mjs`, never by hand | `loadVisualRouter` |

`checkDoctrine(loadDoctrine(), loadRuleRegistry())` returns every issue in the craft registry; it
must return none.

## Adding a craft rule

A rule lives in the file of its source doctrine: `direction`, `story-structure`, `creator-craft`,
`talks-and-slides`, `visual-information-design`, `explainer-motion-craft`, `skills-and-taste` or
`owner-feedback`.

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
  an `owner-feedback` rule uses the owner's rule number instead (`owner-FB3`, `owner-FB2.1`).
  `.<n>` only splits one source row into several rules that share `source.ref`. Never `Q-`: that
  prefix belongs to `rules.yaml`. The id never carries the layer.
- **Text:** 40 words or fewer, the rule's do and don't condensed. Never change a number.
- **Scope:** the VT §4 layer exactly. `B` names `beats`; `T` names `types` or `audiences`; `U*`
  names the profile `param` that supplies its value; `U` and `U*` name neither beats nor types.
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
