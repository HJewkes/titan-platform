# @titan-design/autoresearch

A target-agnostic autoresearch loop on top of `@titan-design/workflow`. A central planner proposes
ideas, Thompson sampling picks them, and each pick climbs a fidelity ladder in its own worktree.
Only a winner that beats the best by more than the measured run-to-run noise moves a ratchet branch.

Inspired by Andrej Karpathy's autoresearch, https://github.com/karpathy/autoresearch (MIT); no code copied.

Tier 2 of the titan-platform DAG. It imports `workflow` (same tier) and `rpc-client` (tier 1); the
`package-layers` rule in `.codewatch/check.json` enforces this in CI.

## What a target supplies

The engine knows no metric, gate or case by name. A target adapter is a directory with
`program.md`, `target.json`, `bounds.json` and the eval, micro, score and test-proof commands. The
host turns those into `ArPorts`; the recipe reads only the parsed `Target` and `Bounds`.

- **`ar-result/v2`**, one evaluator run: `{case, repeat, metrics: {name: number}, gates: {name: bool},
  violations: {name: int}, usd, wall_s}`.
- **`target.json` `metric`** drives the keep rule:
  - `primary`: a metric name plus `min` or `max`;
  - `guards`: metric name to the largest allowed rise of its median over the best's;
  - `zeroTolerance`: violation names, one of which in any run rejects;
  - `allGate`: every gate true, and an idea may not pass less often than the best;
  - `noOp`: the metric whose 0 marks a run that changed nothing;
  - `noise`: the σ band settings.
- **`microRung`** names an L1 rung per change class. A class with none goes from L0 to L2.
- **`bounds.json`** lists the change classes, their path globs and parameter ranges. There is no
  diff-size cap. Diff size is recorded on each outcome and in the planner digest instead.
- **`target.json` `frozen`** lists the evaluator's globs. A class glob that names one stops the
  run before the baseline (`[bounds-frozen]`).

## L0 bounds, guards and the tie-break

L0 is pure engine code over the real diff. A host runs `git diff --no-color --unified=0 -M base
head`, feeds it to `parseUnifiedDiff`, and passes the files to `postCheck`. For a params class it
also passes `changedParams` of the params file at base and head. `postCheck` records one row per
check and returns the first failure as the code. The checks are `frozen-touch`, `outside-class`,
`new-file-outside-tests`, `no-test` (unless the class is in `test.exceptClasses`), `case-name`,
`stray-literal`, and the param range, integer and removal checks. A `banned` entry is on when it
is present and not `false`, whether it is prose or data. A data-form `literalsOutsideConfig`
replaces the default allowed literals `{0, 1, 2, -1}` with its `allowed` list. L0 also measures the
diff size `{files, lines, srcFiles, srcLines, testLines}`, which replaces the implementer's own
count. A guard is a slack (a `min` metric that may not rise) or `{slack, direction}`. A `max` guard
may not fall. Winners within one σ of the strongest Δ count as a tie. The one with the smallest
source diff moves the ratchet.

## Usage

```ts
import { AUTORESEARCH_STEPS, AUTORESEARCH_WORKFLOW, arStepHandlers, runAutoresearch, type ArPorts } from "@titan-design/autoresearch";

declare const ports: ArPorts; // the host's worktree, agent, evaluator and ratchet effects

runtime.register(AUTORESEARCH_WORKFLOW, runAutoresearch, { strictReplay: true });
const routes = arStepHandlers(ports).map(toRoute); // one route per AUTORESEARCH_STEPS dispatch step
runtime.start(AUTORESEARCH_WORKFLOW, { pin: "<commit>", config: JSON.stringify({ lanes: 3, rounds: 10 }) });
```

Every step's input is JSON and its answer comes back under `result`. The ratchet step is `park` on
restart, since a push cut off mid-way may have moved the remote. Every other step is `repeat`.

## Deviations from Karpathy's autoresearch

| Karpathy | Here | Why |
| --- | --- | --- |
| One mutable file | **A worktree of the system**, limited to bounded change classes (`bounds.json`) | A real failure can span several modules. The bounds take over the generalization guard that "one file" provided. |
| One agent, serial experiments | **One central planner** owns one queue with a typed evidence log. Ideas are picked by **Thompson sampling over lineages**. N lanes run in parallel. | Wall time, and one place for judgment and dedup. |
| One fixed-budget run per idea | **Fidelity ladder**: L0 static, L1 micro, L2 one run, L3 repeats with confirm runs. Held-out cases are a **validator**, never used for selection. | Each rung is cheaper than the next, and an idea stops at its first failed rung. |
| Single scalar, "better" keeps | **Gated keep**: zero-tolerance violations, all-gate rate, the primary metric beyond a **2σ noise band** with confirm runs, guard metrics, and a plural-objective ledger | A local score can improve while the system-level gates regress. |
| Fresh context each experiment | **Fixed fork schedule**: warm context for exploit lanes, flushed chat for explore lanes; a cached stable prefix per stage; a model size per stage | Cost, and escaping a basin. |
| Keep = commit on the branch | **Ratchet branch** advanced inside the workflow by a logged merge path. Main gets only asynchronous snapshot pull requests. | The loop never blocks on review. |
| Evaluator frozen by convention | Evaluator **pinned** to a commit, run from a separate clean checkout, hash-checked before and after every eval | Lanes are worktrees of the repo that also holds the evaluator. |
| Discard = reset | The branch is parked (kept, local), and the reason enters the **dead-end and bug registries** that every lane reads | So no lane repeats a known failure. |

## Prior work cited

- Andrej Karpathy, [autoresearch](https://github.com/karpathy/autoresearch) (MIT): the pattern of
  `program.md`, one mutable file, a frozen evaluator and a keep-if-better ratchet.
- Fork-and-Flush (arXiv 2610.07447): a fixed exploit and explore schedule, flushing chat context
  rather than the workspace when a lane forks.
- Bilevel Autoresearch (arXiv 2603.23420): the risk of an evaluator the loop can modify, and of a
  planner that repeats the same changes; hence the pinned evaluator and the diversity quotas.
- AIDE (arXiv 2502.13138): draft, debug and improve-the-best tree search, with a cheap "is it
  broken" check before any score.
- AutoScientists (arXiv 2605.28655): the pooled within-pair σ band with confirm runs, effect-size
  cells with an exploration bonus, and the bold and follow-up planner quotas.
- Recovering Wasted Compute (arXiv 2608.10424): the shared bug registry and Thompson sampling over
  lineages with Beta(1,1) priors.
- OpenEvolve and AlphaEvolve: cascade evaluation that filters weak programs early, and cheap models
  for exploration.

No code is copied from any of them, so no license notice is needed; these are design citations.
