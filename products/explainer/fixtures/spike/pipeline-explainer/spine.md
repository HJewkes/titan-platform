# Story spine: pipeline-explainer

Hand-written for the frozen pipeline-explainer script, in the spine template's shape. The chapters in §8 are the
script's real order, not a corrected one: the architecture map (ch2) comes before the journey (ch3), which Q-E15
fails.

## 1. Viewer
- Who: the owner. Built the factory, knows its names, not every gate's live wiring.

## 3. Journey: one task from "ranked" to "merged"
| # | Step | What happens (one clause) | Why it is needed (what goes wrong without it) | Invariant it must keep | Today: how it breaks (fact id) |
|---|---|---|---|---|---|
| 1 | Rank | the backlog orders open tasks | without an order, work starts by accident | — | — |
| 2 | Claim | the tick turns the top task into a claim | two agents would take the same task | I2 an open pull request locks its files | F6 |
| 3 | Spawn | the broker starts an implementer in its own worktree | agents would overwrite each other's files | — | — |
| 4 | Open | the implementer opens a pull request | nothing else can review or merge the work | — | — |
| 5 | Review | Shepherd runs the gates on the pull request | an unchecked change reaches main | I1 a merge names the exact current head | F11 |
| 6 | Merge | Shepherd merges and the claim closes | the slot stays busy after the work is done | — | — |

## 4. Architecture that carries the task
| Part (map node) | Carries step(s) | Mechanism for each invariant it keeps | Constraint that forces it |
|---|---|---|---|
| Backlog | 1 | — | — |
| Tick | 2 | locks the files a claim touches (I2) | slots are finite |
| Broker | 3 | — | one worktree per agent |
| Implementer | 4 | — | — |
| Shepherd | 5, 6 | merges only the head a verdict names (I1) | main must stay green |

## 5. Constraints (fixed, not chosen)
| Constraint | The mechanism it forces (a part from §4) |
|---|---|
| Slots are finite | Tick |
| Main must stay green | Shepherd |

## 6. Item ledger: every name the viewer will meet
| Item | Kind (step / property / constraint / invariant / part / number) | Defined in beat | Reused in beats |
|---|---|---|---|
| backlog | part | c2-1-line | c3-1-rank |
| tick | part | c2-2-tick | c4-1-wait |
| broker | part | c2-3-broker | c5-1-spawn |
| implementer | part | c2-4-agent | c5-1-spawn |
| Shepherd | part | c2-5-shepherd | c6-1-run |

## 7. Cut list
Other seats, release pull requests, stacked slices, review panels and the decider are not named.

## 8. Chapter order (derived from §2-§5, not from the source doc)
| Ch | Question | Spine rows it covers |
|---|---|---|
| ch1 | Why were twenty-eight slots idle? | — |
| ch2 | Which parts are software, agents, and you? | §4.1, §4.2, §4.3, §4.4, §4.5 |
| ch3 | How does one task rise to the top? | §3.1 |
| ch4 | What must a slice pass before it starts? | §3.2, §3.3 |
| ch5 | What does an implementer owe the line? | §3.4 |
| ch6 | How does a pull request become a merge? | §3.5, §3.6 |
| ch7 | Why do slots sit empty while work is ready? | §5 |
| ch8 | Who must act at each gate? | §4.5 |
| ch9 | What holds the line today? | — |
