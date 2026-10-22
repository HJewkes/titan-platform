# Autoresearch: a ratcheted improvement loop

Autoresearch is a workflow in the [factory](/guides/factory) that improves a system against a
frozen evaluator. A central planner proposes ideas, each idea climbs a ladder of cheaper-to-dearer
checks in its own worktree, and only a winner that beats the best by more than the measured
run-to-run noise moves a ratchet branch. The engine is
[`@titan-design/autoresearch`](/reference/autoresearch); the factory supplies the real ports, the
logged ratchet route and the read commands. This guide covers the run lifecycle and adding a
target.

Inspired by Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) (MIT), the
source of the pattern: `program.md`, one mutable file, a frozen evaluator and a keep-if-better
ratchet. No code is copied, so no license notice is needed; the credit is a design citation. The
extensions and the papers they come from:

- Fork-and-Flush (arXiv 2610.07447): a fixed exploit and explore schedule across lanes.
- Bilevel Autoresearch (arXiv 2603.23420): why the evaluator is pinned and the planner has quotas.
- AIDE (arXiv 2502.13138): draft, debug and improve-the-best tree search.
- AutoScientists (arXiv 2605.28655): the pooled noise band with confirm runs, and planner quotas.
- Recovering Wasted Compute (arXiv 2608.10424): the shared bug registry and Thompson sampling.
- OpenEvolve and AlphaEvolve: cascade evaluation that filters weak programs early.

The package README has the table of deviations from Karpathy's loop.

## The run lifecycle

1. **Pin.** A run starts from a commit that must be on the default branch of the target's clone.
   The evaluator is pinned to it and run from a separate clean checkout.
2. **Baseline.** The evaluator scores the pin on the phase's training cases, repeated several
   times, which also measures the noise band.
3. **Rounds.** The planner fills a queue of ideas. Sampling picks some, and each pick climbs the
   ladder in its own worktree, stopping at its first failed rung:
   - **L0**, static: bounds on the diff, the target's unit tests and the test proof.
   - **L1**, micro: a cheap signal rung, only for change classes that name one.
   - **L2**, one evaluator run.
   - **L3**, repeats with confirm runs.
4. **Ratchet.** The round's winner, if it beats the best beyond the band and trips no guard or
   zero-tolerance violation, advances the run's ratchet branch. Losers are parked and their
   reasons enter the dead-end and bug registries every lane reads.
5. **Milestone.** On request, the best head is scored on held-out cases that only the local
   factory config knows. Only medians and gate pass counts come back, and the number of looks per
   run is capped by the target's `validator.maxLooks`.

## The ratchet is a logged merge path

The ratchet fast-forwards only a run's own branch under the target's `ratchetPrefix`. It refuses
`main`, the remote's default branch and any ref outside `refs/heads/<ratchetPrefix>/`, each with
its own error code, and it records every move as evidence. It is one of the logged merge paths
named in the repo's `CLAUDE.md` and in [Shepherd's merge guard](/guides/shepherd#merge-guard),
and Shepherd does not gate it. Main gets changes only through ordinary pull requests that a person
or Shepherd merges. `pnpm merge:lint` knows this path through its allowlist.

## Reading a run

The console has an Autoresearch page at `#/autoresearch`, with a run view at
`#/autoresearch/<run-id>`. It reads three factory commands over the loopback port:

| Command | Returns |
| --- | --- |
| `autoresearch.runs` | One summary per autoresearch run. |
| `autoresearch.run {runId}` | The run's view: rounds, lanes, outcomes, ratchet moves, validator looks. |
| `autoresearch.diff {runId, ideaId}` | The idea's diff, from the best it was judged against to its head. |

An unknown run, or a run of another workflow, answers `not_found`. The console proxies no write.

## Adding a target

A target adapter is a directory in the target repo, such as `autoresearch/fixture/`. The engine
knows no metric, gate or case by name; it reads only what the adapter declares.

- `program.md`: the brief the planner and implementer read.
- `target.json` (`ar-target/v1`): the keep rule, the rungs and the phases.
- `bounds.json`: the change classes, their path globs and parameter ranges.
- The eval, micro, score and test-proof commands the rungs call.

### target.json

| Field | Meaning |
| --- | --- |
| `ratchetPrefix` | Branch prefix the ratchet may write, such as `autoresearch/fixture`. |
| `metric` | `primary` (name, `min` or `max`), `guards`, `zeroTolerance`, `allGate`, `noOp`, `noise`. |
| `caseSets` | Case alias to the case set it belongs to, such as `train-1` to `suite-a`. |
| `runnerRoot` | The path, relative to a tree, that eval and micro commands run against. |
| `rungs` | Per rung: `cmd` (an argv template), optional `maxUsd` and `timeoutMin`. `seed` is the L2 and L3 eval rung. |
| `microRung` | L1 rung per change class. A class with none goes from L0 straight to L2. |
| `unitTests`, `testProof` | The L0 commands. `testProof` takes `{base}` and `{head}`. |
| `frozen` | Globs no idea may touch and no class may allow. |
| `phases` | Training cases (`train-1`), baseline runs and stop rules. |
| `validator` | `{runs, maxLooks}`: runs per held-out case per look, and looks per run. |

Held-out case names and the validator case list live in the local factory config only, never in
`target.json` or anywhere in the target repo.

### The result line

An eval command prints its one JSON result as the **last non-empty line** of stdout. Anything
before it is the runner's own log. The line is `ar-result/v2`:

```json
{"schema":"ar-result/v2","case":"train-1","repeat":"1","metrics":{"score":0.8},"gates":{"ok":true},"violations":{"leaks":0},"usd":0.4,"wall_s":31}
```

`rung`, `evaluator_pin` and `artifact_dir` are optional. A replay micro rung reads the best's
`artifact_dir` as its baseline, and an idea stops with `no-baseline-dir` when there is none. A
micro rung prints an `ar-micro/v1` line the same way.

### Template tokens

Each `{name}` in a rung's `cmd` is filled before the command runs. A token with no value is an
error, so a command never runs with a literal brace.

| Token | Value |
| --- | --- |
| `{runnerRoot}` | The idea's tree joined with the target's `runnerRoot`. |
| `{caseSet}`, `{case}` | The case set from `caseSets`, and the case being run. |
| `{key}` | A string unique per run and scope, so it may name a cache directory. |
| `{baselineDir}` | The best's `artifact_dir`, for micro rungs. |
| `{microSignal}` | The planner's `<count>:<up\|down>` signal, for micro rungs. |
| `{cluster}` | A micro argument the idea supplies in `microArgs`. |
| `{base}`, `{head}` | The two revisions, for `testProof` only. |
| `{maxUsd}` | The rung's `maxUsd`. |

### Where each command runs

- **Eval and micro** run with the evaluator checkout as the working directory, because their
  scripts are frozen. `{runnerRoot}` points them at the idea's code.
- **Unit tests and the test proof** run in the idea's tree. The proof script itself is read from
  the evaluator checkout.

### Frozen globs

`frozen` entries are matched as git `:(glob)` pathspecs: `**`, `*` and `?`, and no braces. List
the evaluator and everything it reads. A change class whose path glob names a frozen file stops
the run before the baseline with `[bounds-frozen]`.
