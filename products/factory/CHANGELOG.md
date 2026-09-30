# @titan-design/factory

## 0.2.0

### Minor Changes

- bb2565b: Register the `land-pr` workflow: a snapshot of the PR, `land` rounds, one code-owned rerun when every failing check was cancelled or timed out, and otherwise a `ci-failed` gate (`rerun`, `abandon` or `await-fix`, bound to the red head). Add `awaitNewHead` and `awaitNewHeadRoute`, which block until a PR shows a head other than the red one.
- 4c9ee27: Add the land-pr `post-merge` step: after a merge it runs the configured `postMerge.argv` with no shell, passing `LAND_PR_REPO`, `LAND_PR_NUMBER` and `LAND_PR_MERGE_SHA` in the environment. It records the exit, signal, `timedOut` and redacted output tails, or `skipped` when no command is configured. On timeout the chore's process group is killed with SIGKILL. The step is routed `park`, so a crash mid-chore holds the run for a human instead of repeating the chore. A malformed `postMerge` config key, a relative `cwd` or a NUL byte fails the config load.
- 916226c: Add the factory registry (`factory.land`, idempotent on repo#pr; `factory.status`; `factory.gates`, with no resolve command) served as `factory__land`, `factory__status` and `factory__gates`. Add `titan-factory serve [--port]`, and `titan-factory land <owner/repo#N> [--task slug/id]`, which hands the PR to a running server over loopback and otherwise drives it in-process to completion or a gate.
- b9d0dab: Add a long-lived serve mode. `FactoryHost.adopt()` claims unfinished runs and keeps driving them. `startFactoryServer` and `serveFactoryUntilSignal` host the factory database under `@titan-design/daemon` on port 7410 with an empty tool prefix. The server adopts runs at start and sweeps every `leaseMs` for runs whose owner exited without releasing, and `/health` reports run counts by status and pending gates.
- 881098b: Add `titan-factory service install [--port <n>] [--node <path>] [--mcp]`, `uninstall`, `status` and `restart`. Install boots out a loaded job, writes the LaunchAgent plist, bootstraps it and waits for `/health` from launchd's own process, exiting 1 with the tail of `serve.err.log` when it never answers; `--mcp` registers the MCP endpoint with `claude` and never fails the install. `status` exits 0 only when `/health` answers. Each verb fails with one line off macOS; `service plist` is unchanged. The root script `pnpm factory:install` installs, builds factory with its workspace deps and links `~/.local/bin/titan-factory` to the built bin.
- bf44ca0: Add `titan-factory service plist`, which prints the `dev.hjewkes.titan-factory` LaunchAgent plist (`ProcessType` Interactive, `KeepAlive` and `RunAtLoad` true, logs under the XDG state directory). `titan-factory serve` health gains a `github` field: `ok`, or the redacted error from `gh api rate_limit`, probed in the background at most once a minute with a 10 s timeout.
- 3ac10ee: Add the `shepherd.register`, `status`, `list`, `timeline`, `hold`, `release` and `merge` registry commands, served by `titan-factory serve` as MCP tools `shepherd__<cmd>` and `/rpc/shepherd.<cmd>`, and as `titan-factory shepherd <cmd>`. `register` refuses a denied repo before starting anything and is idempotent on `repo#pr` and on the PR's head branch. `merge` evaluates the policy and resolves no gate; gate resolution stays CLI-only. `list` and `timeline` return the `WatchRow` and `PrTimeline` shapes exported from `shepherd/view.ts`.
- 90200c7: `land()` takes a `round`: every dispatch step id after round 0 carries `r<round>`, so a pilot that re-enters `land()` after a rerun or a new head gets fresh step ids. Round 0 keeps its existing ids. Before any merge of an untrusted head, `land()` calls `GatePolicy.decide("merge", { headSha })` and records the decision in a `merge-policy` code step with the policy trace gate. It branches on the recorded decision, so a replay reuses it instead of asking the policy again. On `allow` the step also stores the caller's `allowEvidence`, and `land()` trusts that one head without opening `approve-merge`. hitl refuses automation resolvers, so an automated merge can never resolve that gate. An allow never extends to a head this run's update-branch built, and it does not reset the update count behind `stuck-behind`. `GatePolicy.decide` takes an optional `GateTarget`.
- 3520eb9: Add the Shepherd step `sh-await-verdict`: it waits for the Verdict block in the final message of the dispatched reviewer's agent and session, written after dispatch and naming this PR at the exact head, and records the session-read locator. The deadline ends the wait with `none`.
- 1629204: Add the `shepherd-pr` workflow. It waits in `sh-await-pr` for a registered branch's PR, then lands the PR round by round under `shepherdGatePolicy`. A red head, a dirty PR, or a `FIX_FIRST` or `NO_REPRO` review wakes an agent first; an unhandled wake falls back to land-pr's `ci-failed` gate or the owner's merge gate. The review runs at every green head before the merge decision. Registrations live in a `shepherd_registration` table (migration 4) in the factory database, and every merge goes through a hold, so a held PR never reaches the port's merge. `ShepherdPhases` requests now carry `repo`, `pr` and `round`, wake gains the `fix-proof` kind, and `Verdict` gains `NO_REPRO`. Route sets can carry a `DatabaseTenant`, whose migrations and binding the host applies.
- 7cde3db: Add Shepherd seat policy: `shepherd/seats.ts` reads autonomy-seat/v1 seat files and the charter's hard stops, and `shepherd/policy.ts` resolves the effective per-PR policy as the seat default narrowed by the registration, refusing denied repos. `shepherdGatePolicy` maps it to a `GatePolicy`. Config gains `shepherd.seatsDir`, `shepherd.charterPath` and `shepherd.hardStopRepos`. Every input fails closed: an invalid seat file or configured charter throws `SeatBookInvalid`, a repo key that is not a bare `owner/name` is denied, and a request that does not match `RequestedPolicySchema` throws `RegistrationRefused`. Seat files canonicalise every repo reference at parse: remotes must be a bare `owner/name` and are lowercased. Paths get one comparison key (lowercased, slashes collapsed, trailing slash dropped, `$HOME`, `${HOME}` and the home directory spelled `~`), and a path is accepted only as `~/`, `$HOME/`, `${HOME}/` or `/` followed by plain `[A-Za-z0-9._-]` segments (never `.` or `..`); every other spelling throws. An injected home must be absolute and not `/`. Symlinks are not resolved. One path-to-remote index across all seats resolves every `deny_repos` path, and a path bound to two remotes throws. A deny path no seat binds denies its basename under any owner, and throws unless that basename is a valid repo name. `hardStopRepos` requires `charterPath`, and the charter must be `autonomy-charter/v1` with a `hard_stops` list. A repo several seats list gets the grants they all share. `Seat.paths` maps each lowercased remote to the seat's local checkout path, the cwd for Shepherd spawns.

### Patch Changes

- 9b1aff3: Make the `ci-wait` and `update-branch` step deadlines survive a clock jump: a sleep that overruns by more than a minute defers expiry to one fresh poll at least two minutes after the wake.
- 9b01c07: `land` judges checks over every run at the head with `mergeReadiness` semantics: a red run of a required context blocks even beside a newer green one, a required context needs a run concluding `success` (neutral and skipped no longer pass), and only GitHub Actions runs count, so any red Actions run at the head is `ci-failed`. `@titan-design/github` exports `headCheckFindings`, the check evaluation `mergeReadiness` now delegates to, with `CheckFinding` and `HeadChecksInput`.
- 7214ca9: A malformed factory config file no longer kills commands that never need it. `factoryRoutes` is now a function that builds the routes on first call instead of at module import, so `titan-factory --help` and `service plist` succeed. `loadConfig` reports invalid JSON with the config path.
- 5204caf: Wire the configured `postMerge` command into the production route set: `factoryRoutes` now reads it from the config file, so the land-pr post-merge chore runs instead of always recording `skipped`. A new `configuredRoutes(env, overrides)` builds that route set.
- ced913f: Add `@titan-design/github`: the factory's GitHub REST port (`githubPort`, `ghCliWire`, `evaluateChecks`, `latestPerName`, argument validation and the `fakeGitHub` test wire), moved unchanged with its tests. The factory now depends on it and deletes `src/github/`; its root no longer re-exports the GitHub types and functions, so import them from `@titan-design/github`.
- 5d46953: Add the Shepherd phases contract (`ShepherdPhases`, `WakeRequest`, `WakeOutcome`, `Verdict`) with wake and review stubs. The stubs declare no steps, wake reports `unhandled`, and review returns `none`, so the owner gate keeps deciding until the real phases land (TP-484).
- a2dcdf8: Shepherd's `merge:auto` seat now allows a merge only when authority's `MRG-AU-RV` holds on merge facts collected at the exact head. A new `sh-merge-evidence` step collects the facts and posts one evidence comment per head. Any `.github/` path, including a rename source, still gates. `shepherdLandOptions` hands the evidence record to `allowEvidence`.
- 1f2f01f: Shepherd reads main CI on the merge sha after land returns merged, records green, red or none, and opens the owner gate main-red on red or none. A non-empty `after` stage list runs nothing and opens the owner gate after-stages.
- 26e94c6: Harden Shepherd's merge authority: an unbound store refuses merges through `factoryRoutesFor`, a held branch registration holds its PR before the PR is recorded, the registration's policy can only narrow the run's, a FIX_FIRST or NO_REPRO whose wake is unhandled asks a human instead of reaching the merge decision, and `sh-await-verdict` refuses a non-numeric `writtenAt` or a locator outside the dispatched session.
- b0335d0: `execGh` takes an optional third argument `{ timeoutMs }` that SIGKILLs the `gh` child and rejects when the time passes; callers that omit it behave as before. The factory `/health` probe passes 10 s, so a hung `gh` no longer lingers. `service plist` maps a Homebrew Cellar node path to the prefix symlink when it resolves to the same binary, and accepts an absolute `--node <path>`.
- 6f77fa1: Documentation only. The factory README names the two registered workflows, the `serve` and `land` verbs, the current package list and both gate policies, and links the new usage guides. The code-report README corrects the index time and links its usage guide.
- Updated dependencies [be51d27]
- Updated dependencies [17b952e]
- Updated dependencies [9b01c07]
- Updated dependencies [ced913f]
- Updated dependencies [84b230d]
- Updated dependencies [19e7b14]
- Updated dependencies [661244b]
- Updated dependencies [0bf3f20]
- Updated dependencies [b0335d0]
- Updated dependencies [e5108b7]
  - @titan-design/authority@0.2.0
  - @titan-design/daemon@0.3.1
  - @titan-design/github@0.1.0
  - @titan-design/session-read@0.7.0
  - @titan-design/hitl@0.3.1

## 0.1.0

### Minor Changes

- 27d1ea2: Add the factory product: host, routed step runner, `resume` and `gate resolve` verbs, and the F3 evidence and F5 gate-policy seams.
- 87d48cd: Add the factory GitHub port (a `gh api` adapter with check-then-act writes) and the land core: wait on the latest run of each required check, keep a behind branch current under `expected_head_sha`, and merge the gate-approved head under `sha`.

### Patch Changes

- bee71b0: Read typed step data in the land steps instead of casting parsed output.
- Updated dependencies [629cdd9]
- Updated dependencies [d0ce38a]
- Updated dependencies [c6bb111]
- Updated dependencies [f160116]
- Updated dependencies [3085355]
- Updated dependencies [46dfd6c]
- Updated dependencies [8e2d31f]
- Updated dependencies [d7f09e5]
  - @titan-design/hitl@0.3.0
  - @titan-design/workflow@0.5.0
