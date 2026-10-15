# redesign-explainer-v4 spike fixtures

Frozen inputs for the pace layer (`src/pace-items.ts`, `src/spike-script.ts`, `src/timing.ts`) and the
script-eval slices that build on it. Do not edit them to make a test pass: re-freeze from the sources below
and record the new hashes.

## `script.json`

A subset of the Python-emitted v4 script (`redesign-explainer-v4/script.json` in the explainer research
folder, sha256 `923d7ab3ea419d35e1f90197598f9a8c9f9b6ece7270c00be68e4933955219fd`, 75 beats).

- Beat objects are copied verbatim, in source order: every beat of ch1 and ch2, plus `r3-1-nouns`,
  `r3-3-plans`, `r3b-1-run`, `r3b-3-replay`, `r4-1-plan`, `r5-1-holds`, `r9-1-ladder`, `r10-2-q1` and
  `r10-10-outro` (20 beats).
- `schema`, `id`, `profile`, `facts_pack`, `video`, `maps` and `shared_nodes` are copied verbatim.
- `chapters` keeps only the chapters those beats name. `facts` is dropped; the pace layer never reads it.

It still fails the strict `ScriptSchema` (extra keys such as `band`, `origin`, `render`, `maps` and
map_state `map`/`item`/`old`/`new`, and seven `video.invariants` against a cap of two). That is the point:
`readSpikeScript` reads it without widening `ScriptSchema`.

## `durations.json`

A durations-only extract of motion-spike `examples/samples/redesign-explainer-v4.words.json` at commit
`6a09ca2` (sha256 `ceddfcac4b400130cbb8358127df2028c4d50205039cdedb896ed8b3f6b26a8d`): `{id, durationS}` for
all 75 beats, 742.53 s in total. Word timings, voice and density fields are dropped. The four beats whose
spoken text differs from the frozen script (`r3-2-sentence`, `r3b-5-insert`, `r3b-6-upstream`,
`r3b-7-claim`) are not in `script.json`.

## `labels.json`

The v4 labelled set (`labels/v1`) from the script-evals plan section 4.1, read by `explainer eval calibrate`.
It is hand-written, not frozen from a source file: beat labels for M1, M2, M3, M4 and M5, chapter labels for
M7, the owner-named beats, and the reader-gap item groups with the beats that first use them. Each check is
labelled true, false or borderline; a beat nobody flagged is unlabelled, not negative. Beat ids span all 75
beats of `durations.json`, not only the subset in `script.json`.
