# RF Python goldens (A2)

Outputs of the archived RF Python tools on the two frozen explainer scripts, captured once so the TypeScript
ports (L1-L5, AS1, P7a2) can be tested differentially with no Python in CI (decision 373(2)). The Python ran
in a throwaway harness outside this repository, on the A1 snapshot; no `.py` file and no Python invocation is
part of this repo (R59). Do not edit a golden to make a port pass: a port that disagrees is wrong until the
disagreement is shown to be a Python bug, and then the fix is recorded here.

| File, per script | Tool | What |
|---|---|---|
| `lint.json` | `build_script.py --lint` | The L0 lint issue set as `{beat, check, severity, message}` (`beat` is null for whole-script checks). Both frozen scripts lint clean, so both sets are empty |
| `script.md` | `build_script.py` `render_md` | The two-track script page rendered from the frozen `script.json` (see below) |
| `visual.json` | `build_script.py --visual` | The page's visual track |
| `make_sample.full.json`, `make_sample.synth.json` | `make_sample.py` | The full gen spec (markup stripped) and the synth spec |
| `sweep_moments.json` | `qa/s9/sweep_moments.py` | 2 Hz moments over the words.json timeline with the OutroBeat fade rule; the visual input is this folder's `visual.json` |

The scripts are `redesign-explainer-v4` (the whole 75-beat script, `../redesign-explainer-v4/script-full.json`)
and `review-addendum-v5` (`../review-addendum-v5/script.json`).

## Provenance

`provenance.json` records, per golden: the tool's path in the A1 snapshot and its sha256 (and the
`script_data.py` module `build_script.py` imports), the command line, its exit code and the golden's own
sha256; per script: the frozen script's path and sha256, and the motion-spike branch and commit (from the A1
git bundle) whose `budgets.json`, `mapType.json` and `examples/samples/*` files the tools read, each with its
sha256. `SHA256SUMS` holds the A1 snapshot's lines for those tools, the frozen scripts and the bundle.
`src/golden-provenance.test.ts` fails when a recorded sha256 disagrees with them or a golden file is edited.

Notes from the capture run:

- `script.md` comes from `render_md` over the frozen `script.json`, not from `build_script.py <out>`, which
  rebuilds the script from `script_data.py`. For v4 the two differ in one cue target (`V11 bump:plan` in
  `script_data.py`, `V11 stale:claim` in the frozen script); `rebuiltByMainMatches` records that. The harness
  first asserts that the frozen script's `facts` equal `script_data.py`'s `FACTS`, the one module global
  `render_md` reads.
- The addendum's `script.md` says its plan file was not found: the plan is not in the A1 snapshot, so
  `rules_audit` took its fallback line.
- Sanitized after capture, as the v4 fixture is: one internal seat name became `lead-desk` (`Lead-desk`), and
  two agent names in the addendum tool's own `script.md` text became `reviewer-agent` and `coordinator-a`.
  The lint ran on the unsanitized script; the substitutions keep word counts and cues.
