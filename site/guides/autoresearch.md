# Autoresearch: a ratcheted improvement loop

Autoresearch is a workflow in the [factory](/guides/factory) that improves a system against a
frozen evaluator. A central planner proposes ideas, each idea climbs a ladder of cheaper-to-dearer
checks in its own worktree, and only a winner that beats the best by more than the measured
run-to-run noise moves a ratchet branch. The engine is
[`@titan-design/autoresearch`](/reference/autoresearch); the factory supplies the real ports, the
logged ratchet route, the CLI and the config. This guide covers running a run and adding a target.

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

## The CLI

<!-- CLI surface: from the S4d plan; check against the merged S4d PR -->

The `autoresearch` group of `titan-factory`:

```sh
titan-factory autoresearch start fixture --pin 0123abc --lanes 2 --rounds 6
titan-factory autoresearch status [run-id] [--json]
titan-factory autoresearch add-idea run-1 --file proposal.json
titan-factory autoresearch milestone run-1
titan-factory autoresearch resume run-1
```

- `start <target> --pin <sha>` refuses with `[target-busy]` while an unfinished run holds the
  target, so one target has one live run.
- `status` without a run id lists runs. With one, it prints a line per rung from `none` to `L3`
  with the idea ids that stopped there.
- `add-idea` appends an owner proposal to the run's inbox. The planner reads it at its next
  round. The run must be unfinished.
- `milestone` requires `titan-factory serve` to be running. It refuses with `[max-looks]` once the
  cap is reached, and while the run has no best yet.
- `resume` checks that the run is an autoresearch run, then uses the factory's resume verb.
- A refusal exits with the failure code. Bad arguments exit with the usage code. A read that needs
  `serve` while it is down exits `69`.
- There is no time limit per stage in the config. A rung's own `timeoutMin` in `target.json` still
  applies.

## Config

An `autoresearch` section in the factory config switches the workflow on. Every path is local to
the machine and never lives in a target repo. All values here are synthetic:

```json
{
  "autoresearch": {
    "agentChatBin": "/srv/factory/bin/agent-chat",
    "configDir": "/srv/factory/agents",
    "account": "agents",
    "workRoot": "/srv/factory/work",
    "archiveDir": "/srv/factory/archive",
    "registryPath": "/srv/factory/registry.jsonl",
    "inboxDir": "/srv/factory/inbox",
    "stages": { "planner": { "profile": "planner" }, "implementer": { "profile": "implementer" } },
    "load": { "ceiling": 8, "pollMs": 30000 },
    "limits": { "pool": "agents", "path": "/srv/factory/limits.json" },
    "targets": {
      "fixture": {
        "clone": "/srv/factory/clones/fixture",
        "adapterDir": "autoresearch/fixture",
        "caseNamesFile": "/srv/factory/fixture-cases.txt",
        "validatorCasesFile": "/srv/factory/fixture-validator-cases.txt"
      }
    }
  }
}
```

`stages` chooses the model per stage by agent profile. `run` may override the run defaults, such as
the lane count and the fork schedule. `validatorCasesFile` is the held-out case list the
milestone reads; `caseNamesFile` is the list of case names the bounds check refuses to see
hard-coded in a diff.

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
