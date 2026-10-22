# Budget tests in tool-guard

No assertion under `pnpm test` compares a time reading with a constant. A cost is checked in one of three ways:

- **Work, counted.** `countWork`, `expectWorkPerChar` and `expectLinearWork` in `work-count.ts` count the characters
  the code reads through the string and regex primitives (`indexOf`, `includes`, `exec`, `charCodeAt` and others, each
  weighed by what it read) and the items it `push`es. A cap is a measured figure with headroom, written beside it, and
  the count is the same on every machine and under any load. The call that passes the cap stops the walk.
- **A ratio of thread CPU** at two sizes, interleaved, best of N, in one process: `expectLinearTime` in `linear-time.ts`.
  Use it only where the risk is regex backtracking, which a count cannot see (merge-lint, the GraphQL escape passes,
  `hooked-params`).
- **Fake timers** for the deadline itself: `deadline.test.ts` and `built-hook.test.ts` advance the hook's own timer.

Absolute budgets in milliseconds, which do matter (the hook's 3.5 s deadline on a real machine), run only under the
bench: `pnpm --filter @titan-design/tool-guard bench` sets `TOOL_GUARD_BENCH=1`. There `cpuBudgetIt` checks each
budget test's thread CPU, `withinParseBudget` its parse budget, and `withinWallBudget` the built binary's wall time.
The bench is not part of `pnpm test` or CI: run it on a quiet machine after a change to the classifier's hot paths.

Write a budget test with `cpuBudgetIt(name, cpuMs, body)` or `cpuBudgetIt.each(rows)(...)`; its wall timeout is
`max(30 s, 12 x cpuMs)` and never a per-test timeout. Never read a clock in a test yourself: `clock-rule.test.ts` fails
on any test module other than `cpu-budget.ts` that calls `process.threadCpuUsage`, `process.cpuUsage`,
`process.hrtime`, `performance.now` or `Date.now`. Its allowlist is empty, and it only shrinks.

## Why not time (TP-4047)

TP-3877 moved these tests from wall time to thread CPU. That is load-resistant, not load-proof, and the same class
failed twice more on 2026-10-22: `join-cost` at 1 032 ms against a 1 000 ms CPU budget on main (TP-4040, which then
quartered the row's size), and `hook.test.ts`'s near-linear ratio in a full local `pnpm test`. Each kind of check
fails for its own reason:

- **An absolute CPU budget** moves with the runner. CI thread CPU runs about four times local, and more when the
  runner is busy: SMT siblings, cache and memory contention and cold JIT all count as this thread's CPU. A budget that
  has room on a quiet runner has none on a loaded one, and raising it each time only waits for the next load.
- **An absolute wall budget** (`< 500 ms`, `< 2 s`, `< 4 s`, and the spawned binary's `< 1 s`, which includes node's
  start-up) moves with every other process on the machine: 4 workers on 4 vCPUs beside the main thread's imports and
  every git, bash and node child the tests spawn.
- **A wall-clock ratio from two samples** (`hook.test.ts`, best of 2, small side floored at 5 ms) breaks on one
  preemption of the large run. The scheduler preempts a long run more often than a short one (TP-3612).
- **The deadline tests** waited on real time for a timer to fire beside a busy worker.

Counted work replaces each of them where the walk's cost is in the primitives, which is nearly everywhere. Weighing a
search by the characters it read matters: a rescan to the end through `indexOf` is one call, so a plain call count
would miss it. Measuring with the weights found one such rescan in the source, the `$${` row of
`subscript-comment.test.ts`, which TP-4051 tracks. The CPU-spin mutants in the `parse-budget.sweep` and
`subscript-comment` sidecars became mutants that add counted work, since a spin with no work is something only the
bench can see.

## Why not a wall timeout (TP-3877)

Four tool-guard timing upkeep tasks landed in seven days: TP-3262, TP-3506, TP-3612 and
TP-3876. They share one cause: the property each test proves is work, but its limit was wall
time. A test that asserts CPU time or a ratio ran under a wall-clock timeout that had nothing to
do with its budget, either vitest's 5 s `testTimeout` default or a hand-sized bump (30 s, 60 s,
18 s). TP-3876 and TP-3262 hit the 5 s default, TP-3612 asserted a wall-clock ratio, and
TP-3506 is the CPU-margin form of the same mistake.

- **Load stretches wall time far more than CPU.** CI runs `vitest run` with `pool: "threads"`
  and `maxWorkers: 4` on a 4-vCPU runner. The workers share those cores with the main
  thread's transforms and imports (780 s of import time in an 825 s run) and with the child
  processes tests spawn: git, bash, zsh and Chromium. Each test file is isolated, so every
  file's imports JIT-compile from cold too. A worker's thread therefore gets a fraction of a
  core. On the TP-3876 red run, `subscript-comment` (2.9 s on a green run) and the
  `hooked-params` spaced-operators ratio (3.0 s green) both passed the 5 s default. Their CPU
  assertions would have passed. The wall clock failed them first.
- **CPU time is load-resistant, not load-proof.** CI thread CPU runs about four times local
  CPU: the `secret inside cmd-subst` sweep row takes 47 ms locally and took 250.5 and 258.9 ms on
  CI. SMT siblings, cache contention and cold JIT all count as CPU. That is TP-3506, a
  250 ms budget with no margin. It is a budget-sizing problem, not a timeout one. TP-3898 sized
  `withinParseBudget`'s default from those CI readings (259.4 ms at most) to 500 ms. The row's
  local cost had grown only from about 49 to 60 ms since the sweep landed, so this was no
  regression.
- **A wall-clock ratio is skewed by preemption.** The scheduler preempts a long run more often
  than a short one. That was TP-3612. The ratio checks now time thread CPU.
- **The mutants judge.** fix-proof runs each sidecar's test file with `--testTimeout 30000`,
  but a per-test timeout overrides it. The judge counts only an AssertionError as a kill, so a
  timeout is a failed proof. The TP-3876 `hooked-params` mutant ran about 13 s against a fixed
  30 s timeout and failed on its ratio only at the end of all 15 runs. A runner twice as slow
  would have turned the proof into a timeout.

`cpuBudgetIt` makes the timeout follow from the assertion. The wall timeout is
`12 × cpuMs`. The body's CPU is checked when it ends, and `expectLinearTime` and the env growth
loop also check it between runs. A test that got slower therefore fails on an AssertionError
within one run of its budget. It can only time out if its thread gets less than a twelfth of a
core. The TP-3876 mutants now die by assertion: `hooked-params` at the 8 s budget (about 8.4 s
locally, 96 s limit) and `subscript-comment` at about 5.5 s (30 s limit).

TP-3262's `emulate-script` zsh agreement test is not a budget test. It asserts agreement with
real zsh, and most of its time goes to zsh child processes that thread CPU cannot see. Its
18 s timeout comes from measured CI wall time, and the rule leaves it alone because it reads
no clock.

TP-3850's "Reached heap limit" lines are a different matter. They come from the deliberate
32 MB child in `scripts/dag-check-lock.test.mjs`: the failing heap is 31.2 of 64 MB, not a
2 GB worker, and every file passed in that job.
