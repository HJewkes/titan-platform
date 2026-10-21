# Budget tests in tool-guard

A budget test asserts thread CPU (the hook stays under a parse budget) or a time ratio (a walk
stays linear). Write it with `cpuBudgetIt(name, cpuMs, body)` or `cpuBudgetIt.each(rows)(...)`
from `cpu-budget.ts`, and time work only through `cpuStopwatch`, `withinParseBudget` or
`expectLinearTime`. Never pass a per-test timeout to one, and never read a clock in a test
yourself: `clock-rule.test.ts` fails on any test module other than `cpu-budget.ts` that calls
`process.threadCpuUsage`, `process.cpuUsage`, `process.hrtime`, `performance.now` or
`Date.now`. Its allowlist holds only the deadline tests, where wall time is the behavior. It only shrinks.
A cost paid in a child process is out of this thread's CPU: bound it with the spawn's own
`timeout`, as `parse-fail-closed.test.ts` does for the built hook.

Pick `cpuMs` from the slowest CI wall time of the test on a green run. That is an upper bound
on its CPU there, which runs about four times local CPU. Allow about twice it.

## Why (TP-3877)

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
  250 ms budget with no margin. It is a budget-sizing problem, not a timeout one, and it stays
  open on its own.
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
