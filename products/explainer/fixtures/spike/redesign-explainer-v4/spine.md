# Story spine: redesign-explainer-v4

## 1. Viewer
- Who: the owner. Built the factory and saw the pipeline explainer; decides the redesign's open forks after watching. Knows: the pipeline explainer, Shepherd, the burndown tick, seats. Needs, after watching: what the design keeps, removes and adds; why the removals are safe; the eleven owner calls.

## 2. Problem (two sentences at most)
One task's state is split over four stores joined by two orchestrators that poll each other, so the tick counted 143 claims when about 60 were real (R02). Every seam needs a patch, and twenty mechanisms exist only to patch others.

## 3. Journey: one task from "a planned slice" to "landed on main"
| # | Step | What happens (one clause) | Why it is needed (what goes wrong without it) | Invariant it must keep | Today: how it breaks (fact id) |
|---|---|---|---|---|---|
| 1 | Plan | a planner splits the task into slices, each with a contract, and you approve them in one sitting | an agent would pick its own scope and risk class | I3 stronger review | R46 |
| 2 | Start | the recipe claims an implementer and returns; the pool grants the claim and the broker spawns the agent | unbounded spawns exhaust the runner slots | I4 pool caps hold | — |
| 3 | Open | the agent's push opens a pull request and the runner records the head | later verdicts could not be tied to a head | I2 verdict at head | R29 |
| 4 | Prove | CI goes green and a short-lived reviewer returns a verdict as a claim on the reviewer pool | an unchecked change reaches the queue | I1 merged tree CI | R04 |
| 5 | Raise | a reviewer who sees a security touch raises the class and adds an adversary review | authority changes would be merged on weak review | I3 stronger review | R46 |
| 6 | Fix | a red fact wakes the implementer; its push moves the head and resets every head-pinned requirement | a stale verdict would count for a new head | I2 verdict at head | R29 |
| 7 | Ask | the owner is asked only if the class says so, at a settled head, with an agent-written packet | the owner is asked about heads that move under them | — | R33 |
| 8 | Queue | the merge queue tests main plus ready heads as one candidate and writes an intent marker | two green heads could break main together | I1 merged tree CI | R29 |
| 9 | Land | the queue lands main at that tree, writes the result, and main's CI confirms | a crash between land and record would lose the outcome | I7 survives restart | R62 |
| 10 | Recover | a stalled item's lease expires, and after three re-drives a triager picks restart, defect-and-park, or escalate | a stalled task waits for a human to notice | I6 stalls picked up | R05 |

## 4. Architecture that carries the task
| Part (map node) | Carries step(s) | Mechanism for each invariant it keeps | Constraint that forces it |
|---|---|---|---|
| Backlog | 1 | — | — |
| Plans | 1 | I3: the contract sets the class floor and the implementer can only raise it, so Authority and security changes get stronger review. | owner asked rarely, well |
| Runner | 2, 3, 6, 7, 9, 10 | I2: A verdict counts only at its exact head. The runner records the head, and a push resets every head-pinned requirement. I6: a stalled item's lease expires and stalls get picked up without a human. I7: a marker table per fact. State survives restarts. A crash is recovered by re-running the recipe from the top. | agents crash and stall |
| Broker | 2 | I4: the pool decides which claim is granted, so Pool caps hold. | 20 runner slots |
| Agents | 3, 6 | I5: No agent widens its own permissions. The class flag only raises. | — |
| GitHub + CI | 3, 4 | — | no webhooks · poll GitHub |
| Merge queue | 8, 9 | I1: CI passes on the merged tree. The queue tests main plus ready heads as one candidate before landing. | — |
| Owner | 7 | — | owner asked rarely, well |
| Ops alarms | 10 | — | — |
| Main | 9 | — | — |

## 5. Constraints (fixed, not chosen)
| Constraint | The mechanism it forces (a part from §4) |
|---|---|
| no webhooks · poll GitHub | Runner |
| 20 runner slots | Broker |
| agents crash and stall | Runner |
| owner asked rarely, well | Plans |

## 6. Item ledger: every name the viewer will meet
| Item | Kind (step / property / constraint / invariant / part / number / concept / left-out) | Defined in beat | Reused in beats |
|---|---|---|---|
| 143 claimed | number | r1-2-stake | — |
| 60 real claims | number | r1-2-stake | — |
| 13 min late | number | r1-2-stake | — |
| Backlog | part | r1-3-stores | — |
| Tick | part | r1-3-stores | — |
| Broker | part | r1-3-stores | — |
| Implementer | part | r1-4-shepherd | — |
| Shepherd | part | r1-4-shepherd | — |
| Main | part | r1-4-shepherd | — |
| Reviewer | part | r1-5-seams | — |
| Seat | part | r1-5-seams | — |
| Owner | part | r1-5-seams | — |
| 1,626 messages | number | r1-6-seat | — |
| 313 hand resumes | number | r1-6-seat | — |
| keeps | property | r1-7-promise | — |
| removes | property | r1-7-promise | — |
| adds | property | r1-7-promise | — |
| choose | step | r2-1-jobs | — |
| make | step | r2-1-jobs | — |
| prove | step | r2-1-jobs | — |
| land | step | r2-1-jobs | — |
| keep going | step | r2-1-jobs | — |
| ask the owner | step | r2-1-jobs | — |
| be legible | step | r2-1-jobs | — |
| I1 merged tree CI | invariant | r2-2-inv | — |
| I2 verdict at head | invariant | r2-2-inv | — |
| I3 stronger review | invariant | r2-2-inv | — |
| I4 pool caps hold | invariant | r2-2-inv | — |
| I5 no self-widening | invariant | r2-2-inv | — |
| I6 stalls picked up | invariant | r2-2-inv | — |
| I7 survives restart | invariant | r2-2-inv | — |
| no webhooks · poll GitHub | constraint | r2-3-limits | — |
| 20 runner slots | constraint | r2-3-limits | — |
| agents crash and stall | constraint | r2-3-limits | — |
| owner asked rarely, well | constraint | r2-3-limits | — |
| 20 compensators | number | r2-4-measure | — |
| aim: under five, one clock, one store | property | r2-4-measure | — |
| item | concept | r3-1-nouns | — |
| fact | concept | r3-1-nouns | — |
| step | concept | r3-1-nouns | — |
| wait + claim | concept | r3-1-nouns | — |
| event | concept | r3-1-nouns | — |
| pool | concept | r3-1-nouns | — |
| service | concept | r3-1-nouns | — |
| script, memoized, a return | property | r3-2-sentence | — |
| re-entry | property | r3-2-sentence | — |
| Plans | part | r3-3-plans | — |
| Runner | part | r3-4-runner | — |
| Agents | part | r3-5-runtime | — |
| GitHub + CI | part | r3-5-runtime | — |
| Merge queue | part | r3-5-runtime | — |
| Ops alarms | part | r3-6-owner | — |
| pool policy details | left-out | r3-7-simple | — |
| risk table rows | left-out | r3-7-simple | — |
| stacking | left-out | r3-7-simple | — |
| a five-step recipe | property | r3b-1-run | — |
| 51.5 steps per run | number | r3b-1-run | — |
| key: name, call count | property | r3b-4-today | — |
| 5 parked runs | number | r3b-4-today | — |
| a claim is a marker | property | r3b-7-claim | — |
| risk class | property | r4-1-plan | — |
| exclusive paths | property | r4-1-plan | — |
| plan sitting | step | r4-1-plan | — |
| pool picks | property | r4-2-start | — |
| settled head | property | r4-7-owner | — |
| fixes wait | property | r4-8-rules | — |
| looser or mixed | property | r4-8-rules | — |
| intent marker | property | r4-9-queue | — |
| result | step | r4-9-queue | — |
| confirmation | step | r4-10-main | — |
| fixer from the tip | part | r4-10-main | — |
| escalate | step | r4-11-stall | — |
| two hold slots | number | r5-1-holds | — |
| set per head | property | r5-1-holds | — |
| head moves | property | r5-2-mergeup | — |
| 30–35% of heads | number | r5-2-mergeup | — |
| candidate | part | r5-2-mergeup | — |
| head never moves | property | r5-2-mergeup | — |
| 600 s tick | number | r5-4-tick | — |
| on every event | property | r5-4-tick | — |
| poller backstop | part | r5-4-tick | — |
| hand release | step | r5-5-release | — |
| conformance | property | r5-5-release | — |
| after the F7 eval | constraint | r5-5-release | — |
| ask and wait | property | r5-6-pull | — |
| pull queue | part | r5-6-pull | — |
| 482/717 cancelled | number | r5-7-gates | — |
| 302 head moved | number | r5-7-gates | — |
| one class, settled | property | r5-7-gates | — |
| seat duties | property | r6-1-seat | — |
| lead-desk | part | r6-1-seat | — |
| class floor | property | r6-2-class | — |
| flag only raises | property | r6-2-class | — |
| console | part | r6-3-owner | — |
| registered steps | part | r6-4-steps | — |
| 7 carry modules | number | r7-1-carry | — |
| 341(1) stopgap · gone at M3 | part | r7-1-carry | — |
| safe: the head never moves | property | r7-1-carry | — |
| hold slots · per-head requirements | part | r7-2-holds | — |
| no-reviewer hold · leases | part | r7-2-holds | — |
| defect gates · triager | part | r7-2-holds | — |
| role caps · pools | part | r7-3-caps | — |
| 5-hour ceiling | constraint | r7-3-caps | — |
| 7-day reserve line | constraint | r7-3-caps | — |
| per-run cap | constraint | r7-3-caps | — |
| notices · rarely acted on | part | r7-4-notices | — |
| open-PR lock · after F12 | part | r7-4-notices | — |
| no coordinator in the loop | part | r7-4-notices | — |
| weighted score · gone | part | r7-4b-score | — |
| finish before start | property | r7-4b-score | — |
| tier, then readiness age | property | r7-4b-score | — |
| name + call count · gone | property | r7-4c-replay | — |
| keyed by fact | property | r7-4c-replay | — |
| converged · 0 blockers | property | r7-5-risk1 | — |
| an agent labels the change | property | r7-5-risk1 | — |
| disguised loosening | property | r7-5-risk1 | — |
| gains wait on follow-ups | property | r7-6-risk23 | — |
| seat catches by hand | property | r7-6-risk23 | — |
| 2 orchestrators until M8 | property | r7-6-risk23 | — |
| outbox | part | r8-2-claims | — |
| reconciler | part | r8-2-claims | — |
| contract + risk | part | r8-3-review | — |
| review pool | part | r8-3-review | — |
| packets + triager | part | r8-3-review | — |
| alarms | part | r8-3-review | — |
| why | part | r8-4-tools | — |
| evals + tests | part | r8-4-tools | — |
| expedite | part | r8-4-tools | — |
| M0–M10 | number | r9-1-ladder | — |
| M0\|data honesty | step | r9-2-first | — |
| M1\|shadow + why | step | r9-2-first | — |
| M2\|review queue | step | r9-2-first | — |
| M3\|merge queue | step | r9-2-first | — |
| M4\|fixer wakes | step | r9-3-middle | — |
| M5\|adversary shadow | step | r9-3-middle | — |
| M6\|plan contract | step | r9-3-middle | — |
| M7\|one owner class | step | r9-3-middle | — |
| M8\|dispatch moves | step | r9-4-late | — |
| M9\|restart pacer | step | r9-4-late | — |
| M10\|charter shrink | step | r9-4-late | — |
| Q1 landing | property | r10-1-calls | — |
| Q2 stopgap | property | r10-1-calls | — |
| Q3 rules | property | r10-1-calls | — |
| Q4 fix queue | property | r10-1-calls | — |
| Q5 seats | property | r10-1-calls | — |
| Q6 expedite | property | r10-1-calls | — |
| Q7 sitting | property | r10-1-calls | — |
| Q8 daily | property | r10-1-calls | — |
| Q9 cutover | property | r10-1-calls | — |
| Q10 policy | property | r10-1-calls | — |
| Q11 research | property | r10-1-calls | — |
| (a) fast-forward | property | r10-2-q1 | — |
| (b) API merges | property | r10-2-q1 | — |
| (a) by construction | property | r10-3-q1-default | — |
| (b) final tree only | property | r10-3-q1-default | — |
| default: (b) where rule is off | property | r10-3-q1-default | — |
| Q2 stopgap · build, delete at M3 | property | r10-4-q2-q4 | — |
| Q3 rule-file review rule | property | r10-4-q2-q4 | — |
| Q4 fixes wait after a packet | property | r10-4-q2-q4 | — |
| default: yes to each | property | r10-4-q2-q4 | — |
| Q5 seats on at M8 | property | r10-5-q5-q6 | — |
| default: lead-desk only | property | r10-5-q5-q6 | — |
| Q6 console expedite | property | r10-5-q5-q6 | — |
| default: add at M8 | property | r10-5-q5-q6 | — |
| Q7 blind sitting | property | r10-6-q7-q9 | — |
| Q8 daily line | property | r10-6-q7-q9 | — |
| Q9 shadow bar | property | r10-6-q7-q9 | — |
| cutover is reversible | property | r10-6-q7-q9 | — |
| Q10 pool rules for the score | property | r10-6b-q10-q11 | — |
| Q11 research fan-out | property | r10-6b-q10-q11 | — |
| default: yes to both | property | r10-6b-q10-q11 | — |
| F1 queue age | property | r10-7-followups | — |
| F3 roster | property | r10-7-followups | — |
| F4 gates | property | r10-7-followups | — |
| F7 release | property | r10-7-followups | — |
| F9 notices | property | r10-7-followups | — |
| F11 poller | property | r10-7-followups | — |
| F12 overlaps | property | r10-7-followups | — |
| F13 landing | property | r10-7-followups | — |
| R-A engines | step | r10-7b-research | — |
| R-B build memo | step | r10-7b-research | — |
| R-C waits + claims | step | r10-7b-research | — |
| R-D engine audit | step | r10-7b-research | — |
| why answer\|not measured\|under 5 s | number | r10-8-measures | — |
| superseded asks\|69%\|under 10% | number | r10-8-measures | — |
| no-verdict\|16%\|under 5% | number | r10-8-measures | — |
| latency\|not set\|after F1 | number | r10-8-measures | — |
| find the wake | property | r10-10-outro | — |
| 2 orchestrators | part | r1-1-hook | — |
| 4 stores | part | r1-1-hook | — |
| 11 calls | property | r1-7-promise | r10-1-calls |
| 7 nouns | concept | r3-1-nouns | — |
| ledger | part | r3-4-runner | — |
| github | part | r3-5-runtime | — |
| queue | part | r3-5-runtime | — |
| ops | part | r3-6-owner | — |

## 7. Cut list
Pool policy details, risk table rows and stacking are named only as left out. The seven carry modules' individual names, the per-repo ruleset details and the follow-up methods are not named.

## 8. Chapter order (derived from §2-§5, not from the source doc)
| Ch | Question | Spine rows it covers |
|---|---|---|
| ch1 | Where does one task's state live today? | §2 |
| ch2 | What must any factory do, and keep true? | §5 |
| ch4 | How does one task travel from plan to main? | §3.1, §3.2, §3.3, §3.4, §3.5, §3.6, §3.7, §3.8, §3.9, §3.10 |
| ch3 | What are the new model's parts? | §4.1, §4.2, §4.3, §4.4, §4.5, §4.6, §4.7, §4.8, §4.9, §4.10 |
| ch3b | How does a recipe run, crash and recover? | §3.9, §3.10 |
| ch5 | What does each old mechanism become? | §4.3 |
| ch6 | Where does each role's work go? | §4.3, §4.8 |
| ch7 | What is removed, and what keeps it safe? | §4.3, §4.6 |
| ch8 | What must be built first? | §4 |
| ch9 | In what order does it ship? | — |
| ch10 | Which calls are the owner's? | — |

## 9. List shapes (optional: a beat not named here is `parallel`)
| Beat | Shape (parallel / contrast) |
|---|---|
| r5-2-mergeup | contrast |
| r7-1-carry | contrast |
| r7-3-caps | contrast |
| r7-4b-score | contrast |
| r7-4c-replay | contrast |
