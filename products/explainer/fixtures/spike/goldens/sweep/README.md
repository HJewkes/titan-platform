# Sweep moments golden (A2, TP-2998)

The output of the archived `qa/s9/sweep_moments.py` on the two frozen explainer scripts, captured once in a
throwaway harness outside this repository so render-qa's `sweepMoments` port is tested with no Python in CI
(decision 373(2)). No `.py` file and no Python invocation is part of this repo (R59). Do not edit a golden to make
the port pass.

| File, per script | What |
|---|---|
| `beats.json` | The tool's input, reduced to what it reads: each words.json beat's `id` and `durationS`, with the visual track's `render` |
| `sweep_moments.json` | The tool's output, byte for byte: 2 Hz moments on a grid from the video's start; each beat's settled sample is `end`, and an `OutroBeat` settles on its last sample before its 1 s fade |

`provenance.json` records the tool's path in the A1 snapshot and its sha256, the git bundle's sha256, and per
script the words.json branch, commit, path and sha256, the visual input's sha256, the command line, its exit code
and the sha256 of both files here. The visual input is the A2 `visual.json` golden (TP-2995); the output equals
TP-2995's `sweep_moments.json` once both are parsed. `packages/render-qa/src/fixtures/sweep/` holds a copy that
render-qa's test reads.
