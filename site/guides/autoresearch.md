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

## The CLI

`titan-factory autoresearch` sends each verb to `titan-factory serve` when serve answers on
`--port`, which defaults to serve's port. When serve is down, a verb that is safe without it runs
in this process against the local database.

| Verb | What it does |
| --- | --- |
| `start <target> --pin <sha> [--lanes n] [--rounds n]` | Starts a run on a configured target. The pin is a 7 to 40 character hex sha. The flags override the config's `run` settings for this run. A target holds one unfinished run at a time. Without serve, the run is driven here until it ends or waits on a human. |
| `resume <runId>` | Drives an unfinished autoresearch run in this process. |
| `status [runId] [--json]` | With no run, one line per run. With a run, one line per rung from `none` to `L3` naming the ideas that stopped there, then the ladders still running. `--json` prints the read model. |
| `add-idea <runId> --file <proposal.json>` | Queues an owner proposal, in the planner's proposal shape, for an unfinished run. The run reads it at its next round. |
| `milestone <runId>` | Starts one validator look at the run's best head. **It needs serve:** counting looks and starting one must happen in one process. |

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Done. |
| 1 | A refusal, or a run started in-process that failed. |
| 2 | A bad flag or argument, or a proposal file that is not JSON. |
| 69 | Serve is needed and down (`milestone`); serve is down and there is no local database to read; or serve is busy or not ready. |

Refusals name their code first:

| Code | When |
| --- | --- |
| `[no-config]` | The factory has no `autoresearch` config section. |
| `[no-target]` | The target is not under `autoresearch.targets`. |
| `[target-busy] <runId>` | The target already has an unfinished run. |
| `[run-finished]` | `add-idea` names a run that has ended. |
| `[proposal]` | The proposal does not match the proposal shape. |
| `[no-pin]` | The run has not recorded its pin yet. |
| `[no-best]` | The run has not finished its baseline, so there is no head to look at. |
| `[max-looks] n/max` | The run already has `validator.maxLooks` looks. Failed looks count. |
| `[not_found]` | No autoresearch run has that id. |

The commands behind the verbs are `autoresearch.start`, `autoresearch.add-idea` and
`autoresearch.milestone`, and like every factory command they are also MCP tools on serve.

## Config

Autoresearch is off until the factory's local config file has an `autoresearch` section. Every
path is an absolute local path and never lives in a target repo. A synthetic example:

```json
{
  "autoresearch": {
    "agentChatBin": "/srv/factory/bin/agent-chat",
    "configDir": "/srv/factory/agents-config",
    "account": "fixture@example.invalid",
    "workRoot": "/srv/factory/autoresearch/work",
    "archiveDir": "/srv/factory/autoresearch/archive",
    "registryPath": "/srv/factory/autoresearch/registry.jsonl",
    "inboxDir": "/srv/factory/autoresearch/inbox",
    "stages": { "planner": { "profile": "ar-planner" }, "implementer": { "profile": "ar-implementer" } },
    "load": { "ceiling": 8, "pollMs": 30000 },
    "limits": { "pool": "autoresearch", "path": "/srv/factory/limits.json" },
    "run": { "lanes": 3, "rounds": 50 },
    "targets": {
      "fixture": {
        "clone": "/srv/factory/clones/fixture",
        "adapterDir": "autoresearch/fixture",
        "caseNamesFile": "/srv/factory/autoresearch/fixture-case-names",
        "validatorCasesFile": "/srv/factory/autoresearch/fixture-validator-cases",
        "snapshot": {
          "repo": "fixture-owner/fixture-repo",
          "task": "fixture/FX-1",
          "implementer": "fixture-seat",
          "logDir": "autoresearch/log"
        }
      }
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `agentChatBin`, `configDir`, `account` | The agent-chat binary, the agents account's config directory and the account recorded on each implementer. |
| `workRoot`, `archiveDir`, `registryPath`, `inboxDir` | Evaluator and look checkouts, the round archives, the phase registry (one JSON line per phase) and the owner-idea inboxes. |
| `stages.planner.profile`, `stages.implementer.profile` | The model per stage, chosen by profile. There is no per-stage TTL. |
| `load` | `{ceiling, pollMs, maxWaitMs?}`: a stage starts only while the five-minute load is below `ceiling`. |
| `limits` | `{pool, path}`: the spawn limits file and the pool every spawn is admitted against. |
| `run` | Run defaults: `lanes`, `rounds`, `minPool`, `caseNames`, `forkSchedule` and the snapshot cadence `snapshot: {keptIdeas, spendUsd}`. |
| `targets.<name>` | `clone` (absolute), `adapterDir` (relative to the target repo, no `..`), and the optional `caseNamesFile`, `validatorCasesFile` and `snapshot`. |
| `targets.<name>.snapshot` | `repo` (`owner/name`), `task`, `implementer` (a seat), an optional `reviewer`, and `logDir` (relative to the target repo, no `..`). See [Snapshots and sync](#snapshots-and-sync). |

`caseNamesFile` holds one case name per line. L0 refuses an added line that names one.
`validatorCasesFile` holds one held-out case per line, either `<case>` or `<case>` then a tab then
`<caseSet>`. Without a case set, the target's own `caseSets` entry for that case is used, if it has
one. A look with no validator cases is refused with `[no-validator-cases]`.

## The ratchet is a logged merge path

The ratchet fast-forwards only a run's own branch under the target's `ratchetPrefix`. It refuses
`main`, the remote's default branch and any ref outside `refs/heads/<ratchetPrefix>/`, each with
its own error code, and it records every move as evidence. It is one of the logged merge paths
named in the repo's `CLAUDE.md` and in [Shepherd's merge guard](/guides/shepherd#merge-guard),
and Shepherd does not gate it. Main gets changes only through ordinary pull requests that a person
or Shepherd merges. `pnpm merge:lint` knows this path through its allowlist.

## Snapshots and sync

Kept work reaches main through snapshot pull requests. A target opts in with a `snapshot` block
in its config. Without one, its runs get no snapshot settings and never cut. A host that has the
block but no Shepherd services refuses to start with `[no-shepherd]`.

**Cadence.** After each round is archived, the run checks whether a cut is due. The first trigger
that holds wins:

1. `phase-end`: the run is stopping.
2. `kept`: `run.snapshot.keptIdeas` ideas were kept since the last cut (default 3).
3. `spend`: agent plus model dollars since the last cut reached `run.snapshot.spendUsd` (default
   12).

The check runs only between rounds, so a round can overshoot the spend; each snapshot's log
records the spend since the last cut. Only one snapshot is open at a time. A cut that falls due
while one is open waits. At the run's end it stays pending, and the run finishes without waiting
for review. A cut that fails is recorded, and the next round retries it under the same number.

**What a cut writes.** Snapshot `k` of run `<runId>` on target `<target>` creates:

| Ref | Points at |
| --- | --- |
| `refs/tags/ar/<target>/<runId>/m<k>` | The kept ratchet sha. |
| `refs/heads/<ratchetPrefix>-snap/<runId>/m<k>` | One commit past that sha. It adds `<logDir>/<runId>/m<k>.md` and nothing else. |

Both refs come from one atomic push with create-only leases. A tag is never moved, and the branch
never lands in the ratchet namespace, on `main` or on the default branch. The PR, titled
`ar <target> <phase>-m<k>`, goes from the branch to the default branch. Its body is the log:
kept idea ids with Δ and σ, the spend and the two shas, with no case names. Shepherd registers
the PR under the configured `task` and `implementer` with slice `<phase>-m<k>` and kind
`feature`, and lands it like any other PR. A cut whose push landed but whose PR failed to open
converges on the retry only when the remote tag already points at the same sha and the branch's
first parent is that tag.

**Sync.** While a snapshot is open, each round first reads its PR:

- Still open: nothing changes.
- Closed unmerged: the snapshot's kept work rolls into the next cut.
- Merged: the default branch is merged into the ratchet. The merge's first parent is the old head,
  so the ratchet only gains history and the next PR diffs only new work. The move is an
  `autoresearch.ratchet` record of kind `sync`. When the merge changed code outside `logDir`, the
  best is measured again before the round plans.

The merge never rebases or force-pushes. A conflict, or a frozen path that main changed, pushes
nothing and holds the run at the `ar-sync-gate:<round>` gate, the only wait in the loop. The gate
is answered with `{"resolved": "<sha>"}`, a merge built by hand. The sync takes it only when:

- it contains both the ratchet head and main's tip, or `[sync-resolved]`;
- it changes no frozen path beyond the ones the gate showed, or `[sync-frozen]`.

The allowed paths are recorded on the sync's move. A refused answer is recorded as a failed sync,
and the next round's sync starts again.

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
