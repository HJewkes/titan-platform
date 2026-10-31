# The factory redesign: explainer script v4

Two-track script, schema `script/v1`. Source of truth: `script.json` beside this file; this page is generated from it
by `tools/build_script.py`. Facts, sources and standing: `facts.md`. Design: `pipeline-redesign-2026-10-13.md` v4
(§8 is the outline, §2.2-2.6 the content), with research R-D's two corrections (facts R60, R61).

**Runtime (planned):** 10:40 over 75 beats and 1583 spoken words, at the provisional C5 bands
(hook 195, diagram 175, code 160, takeaways 180 wpm; `gen_audio.py` re-times each beat from the real WAV).
**Runtime (estimate):** 11:27: v2 beats at their real WAV length, v4 beats planned.

**Narration:** 43 beats reuse v2 audio; 32 are new (`origin: v4`).
**Frozen for S3:** 28: r1-7-promise, r3-1-nouns, r3-4-runner, r3-7-simple, r3b-1-run, r3b-2-crash, r3b-3-replay, r3b-4-today, r4-2-start, r4-3-open, r4-4-prove, r4-6-fix, r4-9-queue, r6-4-steps, r7-4-notices, r7-4b-score, r7-4c-replay, r7-6-risk23, r8-1-core, r8-2-claims, r8-3-review, r8-4-tools, r10-1-calls, r10-6-q7-q9, r10-6b-q10-q11, r10-7b-research, r10-8-measures, r10-9-close.
**CONTESTED, held:** 4. Each asserts an item the v4 adversary blocks (V4-B1..B6) or R-D contradicts;
the design author picks the line or its fallback through tp-operator.

| Beat | Blocker | Line | Fallback (true today) |
|---|---|---|---|
| r3-2-sentence | V4-B1 | One sentence explains it. A recipe is a script, a step is memoized at its head, a wait or claim is a return, and an event re-enters the script. | One sentence explains it. A recipe is a script, each step leaves a memoized marker, a wait or claim is a return, and an event re-enters the script. |
| r3b-5-insert | V4-B3 | Keyed by fact, an inserted step has no marker, so it runs, and the old markers still match. | Keyed by fact, an inserted step has no marker, so it runs, and the old markers still match. Inserts ahead of a landing are still under review. |
| r3b-6-upstream | V4-B4 | Change an upstream step, and the markers that read it go stale. The next entry re-runs only those. | Change an upstream step, and the design marks the markers that read it stale; the next entry re-runs them. How far a change reaches is under review. |
| r3b-7-claim | V4-B2 | A claim is a marker too. If the plan changes after the grant, the grant goes stale and releases its token before anything re-runs. | A claim is a marker too. If what it read changes, the design releases the grant's token before anything re-runs. When grants are checked is under review. |

**Rules applied:** the old explainer's layout and tone (346); results first in every chapter; stake with numbers
before 15 % (Q-W1); one WHAT→HOW pivot (Q-F5); invariants spoken; one simplification line (Q-F12); callback close.
Neutral on the open forks: chapter 10 states §11's decisions with their options and defaults, nothing more.
Numbers rule: a v4 line states only the brief's facts as R-D corrected them (R60-R62, 302 of 482, 30-35 %)
or counts of the design's own parts. `map_state.map` picks the `old` or `new` map, or `split` for both.
Chapter 3b's `visual.recipe` follows the RecipeRunBeat data contract in the v4 plan (§3 S2).

**L0 lint:** 0 errors, 0 warnings

## Video

- **Audience:** the owner: built the factory, saw the pipeline explainer, decides the redesign's open forks after watching.
- **Stake:** claimed 143 vs about 60 real; DONE seen up to 13 min late; 313 hand resumes in two weeks (R02, R03, R05).
- **Promise:** By the end, you can name what the redesign keeps, removes and adds, and the eleven calls that are yours.
- **Thesis:** A recipe is a script; a step is memoized at its head; a wait or claim is a return; an event re-enters the script.
- **Generic model:** seven nouns: work item, fact, step, wait and claim, event, pool, service.
- **Fence:** today's factory: the burndown tick plus Shepherd, joined by the seat (pipeline explainer, 337): two orchestrators and four stores joined by polling and a coordinator; the design keeps one marker table and one clock.
- **Running example:** one unnamed slice, followed from plan to main in chapter 4 (design §2.6)
- **Invariants:** CI passes on the merged tree. / A verdict counts only at its exact head. / Authority and security changes get stronger review. / Pool caps hold. / No agent widens its own permissions. / Stalls get picked up without a human. / State survives restarts.
- **Simplification:** Leaves out pool policy details, risk table rows and stacking; each is data in a table, a policy or a plan.
- **Close:** callback.

## The maps (persistent cast)

Hand layout on a 1920×1080 canvas: node boxes 280×116, drawn at 40 px while the boxes are fixed (mapMetrics.ts),
so labels of 11 characters or fewer; at mapType.json's 44 px the cap is 10. The new map's `ledger` now reads Runner.
Shared nodes at identical centres on both maps: backlog, broker, owner, main.
Colour is the actor type: **software** blue, **agent** amber, **human** red, store grey.

### Map `old`

| Node | Label | Actor | Centre |
|---|---|---|---|
| `backlog` | Backlog | store | 200,230 |
| `tick` | Tick | software | 770,230 |
| `broker` | Broker | software | 1340,230 |
| `implementer` | Implementer | agent | 1720,230 |
| `seat` | Seat | agent | 960,495 |
| `shepherd` | Shepherd | software | 1340,495 |
| `reviewer` | Reviewer | agent | 1720,495 |
| `owner` | Owner | human | 960,750 |
| `main` | Main | software | 1720,750 |

| Edge | From → to | Label |
|---|---|---|
| `e:backlog->tick` | backlog → tick | reads |
| `e:tick->broker` | tick → broker | spawn |
| `e:broker->implementer` | broker → implementer |  |
| `e:implementer->shepherd` | implementer → shepherd | PR |
| `e:shepherd->main` | shepherd → main | merge |
| `e:tick->shepherd` | tick → shepherd | re-register |
| `e:shepherd->broker` | shepherd → broker |  |
| `e:reviewer->shepherd` | reviewer → shepherd |  |
| `e:shepherd->seat` | shepherd → seat |  |
| `e:shepherd->owner` | shepherd → owner | gates |
| `e:seat->owner` | seat → owner | asks |

Flows: `flow:old` = backlog → tick → broker → implementer → shepherd → main.

### Map `new`

| Node | Label | Actor | Centre |
|---|---|---|---|
| `backlog` | Backlog | store | 200,230 |
| `plans` | Plans | store | 770,230 |
| `broker` | Broker | software | 1340,230 |
| `agents` | Agents | agent | 1720,230 |
| `ops` | Ops alarms | software | 960,495 |
| `ledger` | Runner | software | 1340,495 |
| `github` | GitHub + CI | software | 1720,495 |
| `owner` | Owner | human | 960,750 |
| `queue` | Merge queue | software | 1340,750 |
| `main` | Main | software | 1720,750 |

| Edge | From → to | Label |
|---|---|---|
| `e:backlog->plans` | backlog → plans | plan |
| `e:plans->ledger` | plans → ledger | contracts |
| `e:ledger->broker` | ledger → broker | spawn |
| `e:broker->ledger` | broker → ledger | events |
| `e:broker->agents` | broker → agents |  |
| `e:agents->github` | agents → github | push |
| `e:ledger->github` | ledger → github | polls |
| `e:ledger->queue` | ledger → queue |  |
| `e:queue->main` | queue → main |  |
| `e:ledger->owner` | ledger → owner |  |
| `e:ledger->ops` | ledger → ops |  |

Flows: `flow:item` = backlog → plans → ledger → broker → agents → github → ledger → queue → main; `flow:ask` = ledger → owner.

## Chapters

| Id | Label | Question | Starts |
|---|---|---|---|
| ch1 | Today · Where does one task live? | Where does one task's state live today? | 0:00 |
| ch2 | Jobs · What must a factory do? | What must any factory do, and keep true? | 0:54 |
| ch3 | Model · What replaces the parts? | What are the new model's parts? | 1:29 |
| ch3b | Recipe · How does a recipe run? | How does a recipe run, crash and recover? | 2:28 |
| ch4 | One task · How does it reach main? | How does one task travel from plan to main? | 3:35 |
| ch5 | Side by side · What changes? | What does each old mechanism become? | 5:27 |
| ch6 | Moves · Where does each role go? | Where does each role's work go? | 6:13 |
| ch7 | Removed · Why is that safe? | What is removed, and what keeps it safe? | 6:41 |
| ch8 | Added · What must be built? | What must be built first? | 7:51 |
| ch9 | Ladder · In what order? | In what order does it ship? | 8:27 |
| ch10 | Your calls · What is open? | Which calls are the owner's? | 9:00 |

## Today · Where does one task live?

### r1-1-hook · HOOK · explain · hook · 6 s @ 0:00

*origin:* `v2`

> Four stores hold one task's state today, joined by two orchestrators that poll each other.

- **Assertion:** One task, four stores, two orchestrators
- **Job:** `numbers` · **Render:** `HookBeat`
- cue `Four` → V11 card:4 stores
- cue `Two` → V11 card:2 orchestrators
- chip [measured] adversarial-review-2026-10-13.md §1
- facts: R01

### r1-2-stake · STAKE · explain · hook · 9 s @ 0:06

*origin:* `v2`

> The tick counted a hundred and forty-three claims when about sixty were real. A finished report can wait up to thirteen minutes to be seen.

- **Assertion:** Seams between stores show up as errors
- **Job:** `numbers` · **Render:** `StatBeat`
- cue `forty-three` → V11 stat:143 claimed
- cue `sixty` → V11 stat:60 real claims
- cue `thirteen` → V11 stat:13 min late
- chip [measured] adversarial-review-2026-10-13.md §1; system-review-2026-10-13.md B2
- chip [estimated] adversarial-review-2026-10-13.md §1; system-review-2026-10-13.md line 252
- facts: R02, R03

### r1-3-stores · WHAT · explain · diagram · 8 s @ 0:15 · in: *and*

*origin:* `v2`

> The backlog holds the task file. The burndown tick keeps a ledger, and the broker keeps a roster of agents.

- **Assertion:** Each part keeps its own store
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "old", "level": "containers", "reveal": [{"id": "backlog", "atCue": "backlog"}, {"id": "tick", "atCue": "tick"}, {"id": "broker", "atCue": "broker"}], "edges": [{"id": "e:backlog->tick", "atCue": "ledger"}, {"id": "e:tick->broker", "atCue": "roster"}], "pins": [{"anchor": "backlog", "text": "task file", "atCue": "file"}, {"anchor": "tick", "text": "burndown.json", "atCue": "ledger"}, {"anchor": "broker", "text": "roster", "atCue": "roster"}]}`
- chip [measured] adversarial-review-2026-10-13.md §1
- chip [our-framing] hand layout of the factory maps
- facts: R01

### r1-4-shepherd · WHAT · explain · diagram · 7 s @ 0:23 · in: *then*

*origin:* `v2`

> An implementer opens a pull request for Shepherd, which keeps a fourth store and merges to main.

- **Assertion:** Shepherd keeps a fourth store
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "old", "level": "containers", "reveal": [{"id": "implementer", "atCue": "implementer"}, {"id": "shepherd", "atCue": "Shepherd"}, {"id": "main", "atCue": "main"}], "edges": [{"id": "e:broker->implementer", "atCue": "implementer"}, {"id": "e:implementer->shepherd", "atCue": "request"}, {"id": "e:shepherd->main", "atCue": "merges"}], "pins": [{"anchor": "shepherd", "text": "sqlite3", "atCue": "store"}]}`
- chip [measured] adversarial-review-2026-10-13.md §1
- chip [our-framing] hand layout of the factory maps
- facts: R01

### r1-5-seams · WHAT · explain · diagram · 10 s @ 0:30 · in: *and*

*origin:* `v2`

> Around them: a reviewer, a coordinator seat, and you. Shepherd's asks for reviewers time out in batches, and the tick re-registers pull requests as a backstop.

- **Assertion:** Every seam needs a patch
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "old", "level": "containers", "reveal": [{"id": "reviewer", "atCue": "reviewer"}, {"id": "seat", "atCue": "seat"}, {"id": "owner", "atCue": "you"}], "edges": [{"id": "e:reviewer->shepherd", "atCue": "reviewer"}, {"id": "e:shepherd->seat", "atCue": "seat"}, {"id": "e:shepherd->owner", "atCue": "you"}, {"id": "e:seat->owner", "atCue": "you"}, {"id": "e:shepherd->broker", "atCue": "batches"}, {"id": "e:tick->shepherd", "atCue": "re-registers"}], "annotations": [{"kind": "box", "anchor": "broker", "atCue": "batches"}]}`
- chip [estimated] adversarial-review-2026-10-13.md §1, §5.5; pipeline-redesign-2026-10-13.md §9
- chip [docs-claim] adversarial-review-2026-10-13.md §2 row 7; pipeline-redesign-2026-10-13.md §3.4
- chip [our-framing] hand layout of the factory maps
- facts: R04, R06

### r1-6-seat · STAKE · explain · hook · 9 s @ 0:40 · in: *and*

*origin:* `v2`

> One thousand six hundred and twenty-six messages went to the seat. In two weeks, three hundred and thirteen held fix rounds waited on a hand resume.

- **Assertion:** The seat patches seams by hand
- **Job:** `numbers` · **Render:** `StatBeat`
- cue `twenty-six` → V11 stat:1,626 messages
- cue `thirteen` → V11 stat:313 hand resumes
- chip [measured] pipeline-redesign-2026-10-13.md §9; adversarial-review-2026-10-13.md §1, §2 row 1
- facts: R05

### r1-7-promise · PROMISE · explain · hook · 5 s @ 0:49 · in: *so*

*origin:* `v4`

> The redesign keeps, removes and adds parts, and leaves eleven calls to you.

- **Assertion:** Keeps, removes, adds, and your calls
- **Job:** `numbers` · **Render:** `HookBeat`
- cue `keeps` → V11 card:keeps
- cue `removes` → V11 card:removes
- cue `adds` → V11 card:adds
- cue `eleven` → V11 card:11 calls
- chip [docs-claim] pipeline-redesign-2026-10-13.md §11
- facts: R51

## Jobs · What must a factory do?

### r2-1-jobs · WHAT · explain · takeaways · 7 s @ 0:54

*origin:* `v2`

> Seven jobs come first: choose, make and prove. Then land, keep going, ask the owner, and stay legible.

- **Assertion:** Seven jobs any factory must do
- **Job:** `artifact-filling` · **Render:** `ScorecardTable`
- cue `choose` → V11 job:choose
- cue `make` → V11 job:make
- cue `prove` → V11 job:prove
- cue `land` → V11 job:land
- cue `going` → V11 job:keep going
- cue `ask` → V11 job:ask the owner
- cue `legible` → V11 job:be legible
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.1
- facts: R07

### r2-2-inv · WHAT · explain · takeaways · 13 s @ 1:01 · in: *and*

*origin:* `v2`

> CI passes on the merged tree; a verdict counts only at its exact head; authority and security get stronger review. Caps hold, no agent widens its permissions, stalls heal unaided, and state survives restarts.

- **Assertion:** Seven invariants hold whatever the mechanism
- **Job:** `artifact-filling` · **Render:** `ScorecardTable`
- cue `CI` → V11 inv:I1 merged tree CI
- cue `verdict` → V11 inv:I2 verdict at head
- cue `stronger` → V11 inv:I3 stronger review
- cue `Caps` → V11 inv:I4 pool caps hold
- cue `widens` → V11 inv:I5 no self-widening
- cue `stalls` → V11 inv:I6 stalls picked up
- cue `survives` → V11 inv:I7 survives restart
- chip [docs-claim] pipeline-redesign-2026-10-13.md header
- facts: R08

### r2-3-limits · WHAT · explain · diagram · 7 s @ 1:14 · in: *but*

*origin:* `v2`

> No webhooks reach this box, CI has twenty runners, agents crash, you want to be asked rarely.

- **Assertion:** Four limits the design cannot change
- **Job:** `numbers` · **Render:** `ListBeat`
- cue `webhooks` → V11 row:no webhooks · poll GitHub
- cue `twenty` → V11 row:20 runner slots
- cue `crash` → V11 row:agents crash and stall
- cue `rarely` → V11 row:owner asked rarely, well
- chip [docs-claim] pipeline-redesign-2026-10-13.md header
- facts: R09

### r2-4-measure · WHAT · explain · diagram · 8 s @ 1:21 · in: *so*

*origin:* `v2`

> Twenty mechanisms exist only to patch others. The design aims for under five, with one clock and one store.

- **Assertion:** Twenty patches today; the aim is under five
- **Job:** `numbers` · **Render:** `StatBeat`
- cue `twenty` → V11 stat:20 compensators
- cue `aims` → V11 chip:aim: under five, one clock, one store
- chip [target] pipeline-redesign-2026-10-13.md §1; adversarial-review-2026-10-13.md §2
- facts: R10

## Model · What replaces the parts?

### r3-1-nouns · WHAT · explain · diagram · 7 s @ 1:29

*origin:* `v4`

> Seven nouns carry the new model. Item, fact and step; wait and claim; event, pool and service.

- **Assertion:** Seven nouns carry the whole model
- **Job:** `artifact-filling` · **Render:** `HookBeat`
- cue `Seven` → V11 card:7 nouns
- cue `item` → V11 card:item
- cue `fact` → V11 card:fact
- cue `step` → V11 card:step
- cue `wait` → V11 card:wait + claim
- cue `event` → V11 card:event
- cue `pool` → V11 card:pool
- cue `service` → V11 card:service
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.2
- facts: R58

### r3-2-sentence · GENERIC_MODEL · explain · diagram · 11 s @ 1:36 · in: *and*

*origin:* `v4`

> One sentence explains it. A recipe is a script, a step is memoized at its head, a wait or claim is a return, and an event re-enters the script.

**CONTESTED (V4-B1):** Review-type facts may key by diff digest, not head; R-D §0 item 3: reads of holds, policy, roster and mergeability change without a head move.

> *Fallback:* One sentence explains it. A recipe is a script, each step leaves a memoized marker, a wait or claim is a return, and an event re-enters the script.

- **Assertion:** Script, memo, return, re-entry
- **Job:** `map` · **Render:** `StepRailBeat`
- cue `recipe` → V11 rail:script, memoized, a return
- cue `re-enters` → V11 rail:re-entry
- chip [docs-claim] pipeline-redesign-2026-10-13.md §1, §8 ch 3
- facts: R59

### r3-3-plans · WHAT · explain · diagram · 7 s @ 1:47 · in: *so*

*origin:* `v2`

> On the new map, backlog and broker keep their places. Plans carry a contract for every slice.

- **Assertion:** Backlog and broker stay put; plans gain contracts
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "reveal": [{"id": "backlog", "atCue": "backlog"}, {"id": "broker", "atCue": "broker"}, {"id": "plans", "atCue": "Plans"}], "edges": [{"id": "e:backlog->plans", "atCue": "contract"}], "pins": [{"anchor": "plans", "text": "contract per slice", "atCue": "slice"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 1
- chip [our-framing] hand layout of the factory maps
- facts: R17

### r3-4-runner · WHAT · explain · diagram · 10 s @ 1:54 · in: *and*

*origin:* `v4`

> One runner and its marker table replace the tick and Shepherd. It re-runs a recipe on every event; its only clock, the reconciler, polls GitHub.

- **Assertion:** One runner replaces tick and Shepherd
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "reveal": [{"id": "ledger", "atCue": "runner"}], "edges": [{"id": "e:plans->ledger", "atCue": "replace"}, {"id": "e:ledger->broker", "atCue": "recipe"}, {"id": "e:broker->ledger", "atCue": "event"}], "pins": [{"anchor": "ledger", "text": "marker table", "atCue": "marker"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3, §1, §4 A1, A3, A7
- chip [our-framing] hand layout of the factory maps
- facts: R63

### r3-5-runtime · WHAT · explain · diagram · 8 s @ 2:04 · in: *and*

*origin:* `v2`

> The broker becomes a runtime that spawns short-lived agents. Agents push to GitHub, and a merge queue lands the work.

- **Assertion:** The broker becomes a runtime
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "reveal": [{"id": "agents", "atCue": "agents"}, {"id": "github", "atCue": "GitHub"}, {"id": "queue", "atCue": "queue"}], "edges": [{"id": "e:broker->agents", "atCue": "spawns"}, {"id": "e:agents->github", "atCue": "push"}, {"id": "e:ledger->github", "atCue": "GitHub"}, {"id": "e:ledger->queue", "atCue": "queue"}], "annotations": [{"kind": "box", "anchor": "broker", "atCue": "runtime"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 (after step 9)
- chip [our-framing] hand layout of the factory maps
- facts: R14

### r3-6-owner · WHAT · explain · diagram · 8 s @ 2:12 · in: *and*

*origin:* `v2`

> Main stays put, and so do you, reading packets in a console. Alarms go to ops, not you.

- **Assertion:** Main and owner stay; alarms go elsewhere
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "reveal": [{"id": "main", "atCue": "Main"}, {"id": "owner", "atCue": "you"}, {"id": "ops", "atCue": "ops"}], "edges": [{"id": "e:queue->main", "atCue": "stays"}, {"id": "e:ledger->owner", "atCue": "packets"}, {"id": "e:ledger->ops", "atCue": "Alarms"}], "pins": [{"anchor": "owner", "text": "console", "atCue": "console"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.5, §10.5
- chip [our-framing] hand layout of the factory maps
- facts: R15

### r3-7-simple · CAVEAT · explain · diagram · 8 s @ 2:20 · in: *but*

*origin:* `v4`

> Pool policy details, risk table rows and stacking are left out; each is data, so the shape holds.

- **Assertion:** Tables, policies and plans hold the details
- **Job:** `numbers` · **Render:** `ListBeat`
- cue `Pool` → V11 open:pool policy details
- cue `risk` → V11 open:risk table rows
- cue `stacking` → V11 open:stacking
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.4, §2.6 steps 1-2, §2.7
- facts: R75

## Recipe · How does a recipe run?

### r3b-1-run · HOW · explain · code · 13 s @ 2:28 · in: *so*

*origin:* `v4`

> A recipe is a plain script; here are five of its steps. Each step runs, writes a marker for its fact, and returns. A landed run averages fifty-one and a half steps.

- **Assertion:** A recipe is a script of steps
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `five` → V11 note:a five-step recipe
- cue `runs` → V11 run:plan-ci
- cue `fifty-one` → V11 note:51.5 steps per run
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3
- chip [measured] research/R-D-2026-10-13.md §0 item 6
- facts: R64, R60

### r3b-2-crash · HOW · explain · code · 8 s @ 2:41 · in: *but*

*origin:* `v4`

> Halfway through the fifth step, the process crashes. No program counter is stored, and nothing was mid-sleep.

- **Assertion:** A crash leaves only the markers
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `fifth` → V11 run:proof
- cue `crashes` → V11 crash:proof
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3
- facts: R64, R65

### r3b-3-replay · HOW · explain · code · 8 s @ 2:49 · in: *so*

*origin:* `v4`

> Recovery re-runs the script from the top. Four markers match, so it fast-forwards and runs the fifth step.

- **Assertion:** Recovery is a re-run from the top
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `re-runs` → V11 replay
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3
- facts: R64

### r3b-4-today · HOW · explain · code · 12 s @ 2:57 · in: *but*

*origin:* `v4`

> Today's engine keys each result by step name and call count. When a deploy re-keyed one step, its old results went unread, and five parked runs failed to replay.

- **Assertion:** Today a re-keyed step strands its results
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `Today's` → V11 note:key: name, call count
- cue `re-keyed` → V11 bump:ci
- cue `unread` → V11 crash:ci
- cue `five` → V11 note:5 parked runs
- chip [measured] research/R-D-2026-10-13.md §0 items 1-2, §5.1; pipeline-redesign-2026-10-13.md §9
- facts: R61

### r3b-5-insert · HOW · explain · code · 8 s @ 3:09 · in: *so*

*origin:* `v4`

> Keyed by fact, an inserted step has no marker, so it runs, and the old markers still match.

**CONTESTED (V4-B3):** 'Inserting a step is safe' overclaims for a gate ahead of an intent marker, ordering-sensitive effects and reads that change a branch.

> *Fallback:* Keyed by fact, an inserted step has no marker, so it runs, and the old markers still match. Inserts ahead of a landing are still under review.

- **Assertion:** An inserted step runs; old markers match
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `inserted` → V11 insert:conformance
- cue `runs` → V11 replay
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3 Versioning
- facts: R66

### r3b-6-upstream · HOW · explain · code · 8 s @ 3:17 · in: *and*

*origin:* `v4`

> Change an upstream step, and the markers that read it go stale. The next entry re-runs only those.

**CONTESTED (V4-B4):** The version lint is per file, so a rule-file or helper change leaves gating markers valid; bumps need a scope.

> *Fallback:* Change an upstream step, and the design marks the markers that read it stale; the next entry re-runs them. How far a change reaches is under review.

- **Assertion:** A changed step re-runs what read it
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `Change` → V11 bump:ci
- cue `stale` → V11 stale:proof
- cue `re-runs` → V11 replay
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3 Validity
- facts: R67

### r3b-7-claim · HOW · explain · code · 10 s @ 3:25 · in: *and*

*origin:* `v4`

> A claim is a marker too. If the plan changes after the grant, the grant goes stale and releases its token before anything re-runs.

**CONTESTED (V4-B2):** Item facts such as contract:approved never go stale, and a grant is re-checked only on re-entry.

> *Fallback:* A claim is a marker too. If what it read changes, the design releases the grant's token before anything re-runs. When grants are checked is under review.

- **Assertion:** A stale grant gives its token back first
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `claim` → V11 note:a claim is a marker
- cue `changes` → V11 stale:claim
- cue `releases` → V11 release:claim
- cue `re-runs` → V11 replay
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.4 Grant, §2.3
- facts: R68

## One task · How does it reach main?

### r4-0-pivot · LEARNER_Q · explain · diagram · 4 s @ 3:35

*origin:* `v2`

> So how does one task reach main?

- **Assertion:** The shape at rest; now one task
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "message_in_flight": {"flow": "flow:item", "fromHop": 0, "toHop": 8, "atCue": "how"}}`
- chip [our-framing] hand layout of the factory maps
- facts: —

### r4-1-plan · HOW · explain · diagram · 10 s @ 3:39

*origin:* `v2`

> A planner splits it into slices with contracts: risk class, requirements, the change in one sentence, exclusive paths. You approve them in one plan sitting.

- **Assertion:** Every slice carries a contract you approve
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "camera": {"follow": "item", "atCue": "planner"}, "item": {"path": [{"at": "plans", "atCue": "slices"}], "chips": []}, "pins": [{"anchor": "plans", "text": "risk class", "atCue": "risk"}, {"anchor": "plans", "text": "exclusive paths", "atCue": "paths"}, {"anchor": "owner", "text": "plan sitting", "atCue": "sitting"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 1
- chip [our-framing] hand layout of the factory maps
- facts: R17

### r4-2-start · HOW · explain · diagram · 9 s @ 3:49 · in: *then*

*origin:* `v4`

> The recipe claims an implementer and returns. The pool picks which claim to grant, not the item, and the broker spawns the agent.

- **Assertion:** The pool picks which claim to grant
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "ledger", "atCue": "claims"}, {"at": "agents", "atCue": "spawns"}], "chips": [{"text": "claim:implementer", "state": "unmet", "atCue": "claims"}, {"text": "claim:implementer", "state": "met", "atCue": "grant"}]}, "pins": [{"anchor": "ledger", "text": "pool picks", "atCue": "pool"}], "annotations": [{"kind": "circle", "anchor": "agents", "atCue": "spawns"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 2, §2.4
- chip [our-framing] hand layout of the factory maps
- facts: R69

### r4-3-open · HOW · explain · diagram · 10 s @ 3:58 · in: *then*

*origin:* `v4`

> Its push opens a pull request. The runner records the head, and the facts it still needs appear as chips. Path globs can raise its class.

- **Assertion:** A push records the head
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "github", "atCue": "push"}, {"at": "ledger", "atCue": "records"}], "chips": [{"text": "ci:green@h", "state": "unmet", "atCue": "chips"}, {"text": "proof:reproduced@h", "state": "unmet", "atCue": "chips"}, {"text": "verdict:merge@h", "state": "unmet", "atCue": "chips"}]}}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 3
- chip [our-framing] hand layout of the factory maps
- facts: R70

### r4-4-prove · HOW · explain · diagram · 9 s @ 4:08 · in: *then*

*origin:* `v4`

> CI goes green and the proof reproduces. The verdict is a claim on the reviewer pool, and a short-lived reviewer returns merge.

- **Assertion:** Facts turn green at this head
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "ledger", "atCue": "CI"}], "chips": [{"text": "ci:green@h", "state": "met", "atCue": "green"}, {"text": "proof:reproduced@h", "state": "met", "atCue": "reproduces"}, {"text": "claim:reviewer@h", "state": "unmet", "atCue": "claim"}, {"text": "claim:reviewer@h", "state": "met", "atCue": "reviewer"}, {"text": "verdict:merge@h", "state": "met", "atCue": "merge"}]}}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 4
- chip [our-framing] hand layout of the factory maps
- facts: R71

### r4-5-raise · HOW · explain · diagram · 10 s @ 4:17 · in: *but*

*origin:* `v2`

> That reviewer saw a security touch and raised the class, adding an adversary review on another profile or account. Nobody can lower a class.

- **Assertion:** A class can rise, never fall
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "ledger", "atCue": "raised"}], "chips": [{"text": "adversary:merge@h", "state": "unmet", "atCue": "adding"}]}, "annotations": [{"kind": "circle", "anchor": "agents", "atCue": "reviewer"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.2, §2.6 step 4
- chip [our-framing] hand layout of the factory maps
- facts: R21

### r4-6-fix · HOW · explain · diagram · 8 s @ 4:27 · in: *and*

*origin:* `v4`

> A red fact wakes the implementer at once. Its push moves the head and resets every head-pinned chip.

- **Assertion:** A push resets every head-pinned chip
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "agents", "atCue": "wakes"}, {"at": "github", "atCue": "head"}], "chips": [{"text": "ci:green@h", "state": "unmet", "atCue": "resets"}, {"text": "proof:reproduced@h", "state": "unmet", "atCue": "resets"}, {"text": "verdict:merge@h", "state": "unmet", "atCue": "resets"}, {"text": "claim:reviewer@h", "state": "unmet", "atCue": "resets"}, {"text": "adversary:merge@h", "state": "unmet", "atCue": "resets"}]}}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 5, §2.2
- chip [our-framing] hand layout of the factory maps
- facts: R72

### r4-7-owner · HOW · explain · diagram · 10 s @ 4:35 · in: *then*

*origin:* `v2`

> You are asked only if the class says so, at a settled head. An agent writes the packet, which cancels if the head moves before delivery.

- **Assertion:** You are asked once, at a settled head
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "ledger", "atCue": "asked"}], "chips": [{"text": "ci:green@h", "state": "met", "atCue": "asked"}, {"text": "proof:reproduced@h", "state": "met", "atCue": "asked"}, {"text": "verdict:merge@h", "state": "met", "atCue": "asked"}, {"text": "claim:reviewer@h", "state": "met", "atCue": "asked"}, {"text": "adversary:merge@h", "state": "met", "atCue": "asked"}, {"text": "owner:approved@h", "state": "unmet", "atCue": "asked"}]}, "message_in_flight": {"flow": "flow:ask", "fromHop": 0, "toHop": 1, "atCue": "packet"}, "pins": [{"anchor": "owner", "text": "settled head", "atCue": "settled"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 6
- chip [our-framing] hand layout of the factory maps
- facts: R23

### r4-8-rules · HOW · explain · diagram · 11 s @ 4:45 · in: *and*

*origin:* `v2`

> Once it reaches you, fixes wait for your answer. A rule file asks live only for a looser or mixed change, the authority table, or a ruleset.

- **Assertion:** Rule files ask live only when looser
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "ledger", "atCue": "fixes"}], "chips": [{"text": "owner:approved@h", "state": "met", "atCue": "answer"}]}, "pins": [{"anchor": "owner", "text": "fixes wait", "atCue": "fixes"}, {"anchor": "owner", "text": "looser or mixed", "atCue": "looser"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 5, §2.7
- chip [our-framing] hand layout of the factory maps
- facts: R24

### r4-9-queue · HOW · explain · diagram · 11 s @ 4:56 · in: *then*

*origin:* `v4`

> With every chip green, the merge queue tests main plus ready heads as one candidate. It writes an intent marker, lands main at that tree, then writes the result.

- **Assertion:** Landing writes intent, then result
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "queue", "atCue": "merge"}], "chips": []}, "pins": [{"anchor": "queue", "text": "intent marker", "atCue": "intent"}, {"anchor": "ledger", "text": "result", "atCue": "result"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 7, §2.3
- chip [our-framing] hand layout of the factory maps
- facts: R25, R73

### r4-10-main · HOW · explain · diagram · 10 s @ 5:07 · in: *and*

*origin:* `v2`

> The head never moves. Main's CI confirms, and a red main gets one fixer from the tip. The last slice to land closes the task.

- **Assertion:** The head never moves; main confirms
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "item": {"path": [{"at": "main", "atCue": "never"}], "chips": []}, "pins": [{"anchor": "main", "text": "confirmation", "atCue": "confirms"}, {"anchor": "main", "text": "fixer from the tip", "atCue": "tip"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 steps 8-9
- chip [our-framing] hand layout of the factory maps
- facts: R25, R26

### r4-11-stall · HOW · explain · diagram · 10 s @ 5:17 · in: *but*

*origin:* `v2`

> A stalled item's lease expires. After three re-drives, a triager picks one fixed verdict: restart, file a defect and park, or escalate to ops.

- **Assertion:** Stalls end in a fixed verdict
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "annotations": [{"kind": "marker", "anchor": "ledger", "atCue": "lease", "text": "!"}, {"kind": "circle", "anchor": "agents", "atCue": "triager"}], "pins": [{"anchor": "ops", "text": "escalate", "atCue": "escalate"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.5
- chip [our-framing] hand layout of the factory maps
- facts: R27

## Side by side · What changes?

### r5-1-holds · HOW · explain · diagram · 7 s @ 5:27

*origin:* `v2`

> Side by side: hold slots, each class with its own release, become one requirement set per head.

- **Assertion:** Hold slots become per-head requirements
- **Job:** `alternatives-vs-ours` · **Render:** `SplitMapBeat`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "split", "level": "containers", "old": {"focus": {"ids": ["shepherd"], "atCue": "hold"}, "pins": [{"anchor": "shepherd", "text": "two hold slots", "atCue": "slots"}]}, "new": {"focus": {"ids": ["ledger"], "atCue": "requirement"}, "pins": [{"anchor": "ledger", "text": "set per head", "atCue": "head"}]}}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §3.2
- chip [our-framing] hand layout of the factory maps
- facts: R28

### r5-2-mergeup · HOW · explain · diagram · 10 s @ 5:34 · in: *and*

*origin:* `v2`

> Merge-ups move the reviewed head on thirty to thirty-five percent of heads, about a quarter of runner minutes. The queue's candidate leaves heads alone.

- **Assertion:** Merge-ups move heads; the queue does not
- **Job:** `alternatives-vs-ours` · **Render:** `SplitMapBeat`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "split", "level": "containers", "old": {"focus": {"ids": ["shepherd"], "atCue": "Merge-ups"}, "pins": [{"anchor": "shepherd", "text": "head moves", "atCue": "move"}, {"anchor": "shepherd", "text": "30–35% of heads", "atCue": "thirty"}]}, "new": {"focus": {"ids": ["queue"], "atCue": "candidate"}, "pins": [{"anchor": "queue", "text": "candidate", "atCue": "candidate"}, {"anchor": "queue", "text": "head never moves", "atCue": "alone"}]}}`
- chip [measured] pipeline-redesign-2026-10-13.md §9
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 7
- chip [our-framing] hand layout of the factory maps
- facts: R29, R25

### r5-4-tick · HOW · explain · diagram · 5 s @ 5:44 · in: *and*

*origin:* `v2`

> A six-hundred-second tick becomes events, with the poller as a backstop.

- **Assertion:** A timer becomes events plus a backstop
- **Job:** `alternatives-vs-ours` · **Render:** `SplitMapBeat`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "split", "level": "containers", "old": {"focus": {"ids": ["tick"], "atCue": "tick"}, "pins": [{"anchor": "tick", "text": "600 s tick", "atCue": "tick"}]}, "new": {"focus": {"ids": ["ledger", "github"], "atCue": "events"}, "pins": [{"anchor": "ledger", "text": "on every event", "atCue": "events"}, {"anchor": "github", "text": "poller backstop", "atCue": "poller"}]}}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §3.4
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3
- chip [our-framing] hand layout of the factory maps
- facts: R30, R13

### r5-5-release · HOW · explain · diagram · 8 s @ 5:49 · in: *and*

*origin:* `v2`

> Seat release becomes software in steps: deny-only guard changes on conformance, other adversary classes only after the F7 eval.

- **Assertion:** Software releases only after its eval
- **Job:** `alternatives-vs-ours` · **Render:** `SplitMapBeat`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "split", "level": "containers", "old": {"focus": {"ids": ["seat"], "atCue": "Seat"}, "pins": [{"anchor": "seat", "text": "hand release", "atCue": "release"}]}, "new": {"focus": {"ids": ["ledger"], "atCue": "conformance"}, "pins": [{"anchor": "ledger", "text": "conformance", "atCue": "conformance"}, {"anchor": "ledger", "text": "after the F7 eval", "atCue": "eval"}]}}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §10.7, §3.5
- chip [our-framing] hand layout of the factory maps
- facts: R31

### r5-6-pull · HOW · explain · diagram · 4 s @ 5:57 · in: *and*

*origin:* `v2`

> Ask-and-wait reviews become a pull queue, red-main fixes first.

- **Assertion:** Ask-and-wait becomes a pull queue
- **Job:** `alternatives-vs-ours` · **Render:** `SplitMapBeat`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "split", "level": "containers", "old": {"focus": {"ids": ["shepherd", "broker"], "atCue": "Ask-and-wait"}, "pins": [{"anchor": "shepherd", "text": "ask and wait", "atCue": "Ask-and-wait"}]}, "new": {"focus": {"ids": ["agents", "ledger"], "atCue": "pull"}, "pins": [{"anchor": "ledger", "text": "pull queue", "atCue": "pull"}]}}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3
- chip [our-framing] hand layout of the factory maps
- facts: R32, R04

### r5-7-gates · HOW · explain · diagram · 12 s @ 6:01 · in: *and*

*origin:* `v2`

> Of seven hundred seventeen owner gates in seven days, four hundred eighty-two were cancelled, three hundred and two because the head moved. Now one class asks, at a settled head.

- **Assertion:** Most owner gates resolved without you
- **Job:** `alternatives-vs-ours` · **Render:** `SplitMapBeat`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "split", "level": "containers", "old": {"focus": {"ids": ["owner"], "atCue": "owner"}, "pins": [{"anchor": "owner", "text": "482/717 cancelled", "atCue": "eighty-two"}, {"anchor": "owner", "text": "302 head moved", "atCue": "moved"}]}, "new": {"focus": {"ids": ["owner"], "atCue": "settled"}, "pins": [{"anchor": "owner", "text": "one class, settled", "atCue": "settled"}]}}`
- chip [measured] pipeline-redesign-2026-10-13.md §9; adversarial-review-2026-10-13.md §2
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 6
- chip [our-framing] hand layout of the factory maps
- facts: R33, R23

## Moves · Where does each role go?

### r6-1-seat · HOW · explain · diagram · 9 s @ 6:13

*origin:* `v2`

> Seat work goes to the scheduler and the triager, and a seat becomes a partition you switch. Lead-desk becomes the ops alarm sink.

- **Assertion:** Seat work moves into software
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "focus": {"ids": ["ledger", "agents", "ops"], "atCue": "Seat"}, "pins": [{"anchor": "ledger", "text": "seat duties", "atCue": "scheduler"}, {"anchor": "ops", "text": "lead-desk", "atCue": "Lead-desk"}], "annotations": [{"kind": "circle", "anchor": "agents", "atCue": "triager"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §8 ch 6, §2.6, §10.5
- chip [our-framing] hand layout of the factory maps
- facts: R34

### r6-2-class · HOW · explain · diagram · 6 s @ 6:22 · in: *and*

*origin:* `v2`

> The planner's contract sets the class floor, and the implementer can only raise it.

- **Assertion:** The plan sets the class floor
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "focus": {"ids": ["plans", "agents"], "atCue": "contract"}, "pins": [{"anchor": "plans", "text": "class floor", "atCue": "floor"}, {"anchor": "plans", "text": "flag only raises", "atCue": "raise"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.6 step 1, §3.4
- chip [our-framing] hand layout of the factory maps
- facts: R35

### r6-3-owner · HOW · explain · diagram · 7 s @ 6:28 · in: *and*

*origin:* `v2`

> You move to the plan sitting, and to the console for expedites and looser or mixed packets.

- **Assertion:** Your work moves to plan time
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "focus": {"ids": ["plans", "owner"], "atCue": "You"}, "pins": [{"anchor": "plans", "text": "plan sitting", "atCue": "sitting"}, {"anchor": "owner", "text": "console", "atCue": "console"}, {"anchor": "owner", "text": "looser or mixed", "atCue": "looser"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §8 ch 6
- chip [our-framing] hand layout of the factory maps
- facts: R36

### r6-4-steps · HOW · explain · diagram · 6 s @ 6:35 · in: *and*

*origin:* `v4`

> Shepherd's steps become registered steps, burndown becomes a recipe, and agent-chat becomes a runtime.

- **Assertion:** Steps register; burndown becomes a recipe
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "focus": {"ids": ["ledger", "broker"], "atCue": "steps"}, "pins": [{"anchor": "ledger", "text": "registered steps", "atCue": "registered"}], "annotations": [{"kind": "box", "anchor": "broker", "atCue": "runtime"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §8 ch 6, §2.6
- chip [our-framing] hand layout of the factory maps
- facts: R37

## Removed · Why is that safe?

### r7-1-carry · HOW · explain · takeaways · 8 s @ 6:41

*origin:* `v2`

> Seven carry modules and the three forty-one stopgap go at rung three, safe because the queue never moves a head.

- **Assertion:** Carry modules go: heads never move
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `carry` → V11 row:7 carry modules
- cue `stopgap` → V11 row:341(1) stopgap · gone at M3
- cue `never` → V11 row:safe: the head never moves
- chip [docs-claim] pipeline-redesign-2026-10-13.md §3.1, §5 M3
- facts: R38

### r7-2-holds · HOW · explain · takeaways · 8 s @ 6:49 · in: *and*

*origin:* `v2`

> Hold slots give way to per-head requirements. The no-reviewer hold and defect gates give way to leases, re-drives and the triager.

- **Assertion:** Holds and defect gates give way to leases
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `Hold` → V11 row:hold slots · per-head requirements
- cue `no-reviewer` → V11 row:no-reviewer hold · leases
- cue `defect` → V11 row:defect gates · triager
- chip [docs-claim] pipeline-redesign-2026-10-13.md §3.1-§3.3
- facts: R39

### r7-3-caps · HOW · explain · takeaways · 8 s @ 6:57 · in: *and*

*origin:* `v2`

> Role caps give way to pools and three hard stops: the five-hour ceiling, the seven-day reserve line, and the per-run cap.

- **Assertion:** Pools and three hard stops replace caps
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `Role` → V11 row:role caps · pools
- cue `five-hour` → V11 row:5-hour ceiling
- cue `seven-day` → V11 row:7-day reserve line
- cue `per-run` → V11 row:per-run cap
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.2, §3.4
- facts: R40

### r7-4-notices · HOW · explain · takeaways · 9 s @ 7:05 · in: *and*

*origin:* `v4`

> Notices go: almost no park refusal was acted on. The file lock goes after F12, and no coordinator stays in the loop.

- **Assertion:** Notices, the file lock and coordinator go
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `Notices` → V11 row:notices · rarely acted on
- cue `lock` → V11 row:open-PR lock · after F12
- cue `coordinator` → V11 row:no coordinator in the loop
- chip [measured] pipeline-redesign-2026-10-13.md §9; system-review-2026-10-13.md B16
- chip [docs-claim] pipeline-redesign-2026-10-13.md §3.4, §6 R6, §10.5
- facts: R41, R42

### r7-4b-score · HOW · explain · takeaways · 7 s @ 7:14 · in: *and*

*origin:* `v4`

> The weighted score goes. Two pool rules replace it: finish before start, then tier and readiness age.

- **Assertion:** Two pool rules replace the score
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `score` → V11 row:weighted score · gone
- cue `finish` → V11 row:finish before start
- cue `tier` → V11 row:tier, then readiness age
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.4 Policy, §11 Q10
- facts: R74

### r7-4c-replay · HOW · explain · takeaways · 9 s @ 7:21 · in: *and*

*origin:* `v4`

> Replay keyed by step name and call count goes. Markers are keyed by fact instead; a run-wide counter key is what parked five runs.

- **Assertion:** Counter-keyed replay goes
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `count` → V11 row:name + call count · gone
- cue `keyed` → V11 row:keyed by fact
- cue `five` → V11 row:5 parked runs
- chip [measured] research/R-D-2026-10-13.md §0 items 1-2, §5.1; pipeline-redesign-2026-10-13.md §9
- facts: R61

### r7-5-risk1 · CAVEAT · explain · takeaways · 13 s @ 7:30 · in: *but*

*origin:* `v2`

> The adversary converged with no blocking objection, but kept three risks. First, an agent labels rule-file changes no checker covers, so a disguised loosening could skip your live ask. The adversary must still approve.

- **Assertion:** Converged, with three risks on record
- **Job:** `alternatives-vs-ours` · **Render:** `ListBeat`
- cue `converged` → V11 row:converged · 0 blockers
- cue `agent` → V11 risk:an agent labels the change
- cue `loosening` → V11 risk:disguised loosening
- chip [docs-claim] adversarial-review-2026-10-13.md Round 3
- chip [docs-claim] adversarial-review-2026-10-13.md Round 3 item 1
- facts: R43, R44

### r7-6-risk23 · CAVEAT · explain · takeaways · 8 s @ 7:43 · in: *and*

*origin:* `v4`

> Second, big gains wait on follow-ups; F7 must price the seat's hand catches. Third, two orchestrators remain until rung eight.

- **Assertion:** Gains wait on tests; two orchestrators remain
- **Job:** `alternatives-vs-ours` · **Render:** `ListBeat`
- cue `gains` → V11 risk:gains wait on follow-ups
- cue `hand` → V11 risk:seat catches by hand
- cue `orchestrators` → V11 risk:2 orchestrators until M8
- chip [docs-claim] adversarial-review-2026-10-13.md Round 3 items 2-3
- chip [measured] pipeline-redesign-2026-10-13.md §9; adversarial-review-2026-10-13.md §5.8
- facts: R45, R46

## Added · What must be built?

### r8-1-core · HOW · explain · diagram · 9 s @ 7:51

*origin:* `v4`

> Eighteen additions build it, in twelve groups. First the core: the marker table, the step registry and the runner, then waits and events.

- **Assertion:** Eighteen additions; the runner's core comes first
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "annotations": [{"kind": "box", "anchor": "ledger", "atCue": "additions"}, {"kind": "box", "anchor": "broker", "atCue": "waits"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §4, §8 ch 8
- chip [docs-claim] pipeline-redesign-2026-10-13.md §4 A1-A4
- chip [our-framing] hand layout of the factory maps
- facts: R47, R76

### r8-2-claims · HOW · explain · diagram · 10 s @ 8:00 · in: *and*

*origin:* `v4`

> Claims and pools gate every spawn. An outbox guards each land and deploy, against the bug behind two deploy rollbacks. A reconciler reads GitHub.

- **Assertion:** Claims, an outbox and a reconciler
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "pins": [{"anchor": "main", "text": "outbox", "atCue": "outbox"}, {"anchor": "ledger", "text": "reconciler", "atCue": "reconciler"}], "annotations": [{"kind": "box", "anchor": "broker", "atCue": "Claims"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §4 A5-A7
- chip [measured] pipeline-redesign-2026-10-13.md §9, §2.3
- chip [our-framing] hand layout of the factory maps
- facts: R77, R62

### r8-3-review · HOW · explain · diagram · 11 s @ 8:10 · in: *and*

*origin:* `v4`

> Plans gain a contract and the risk table. A review pool and the merge queue prove and land the work. Packets, a triager and alarms handle the rest.

- **Assertion:** Contracts, review pool, queue, packets, alarms
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "pins": [{"anchor": "plans", "text": "contract + risk", "atCue": "contract"}, {"anchor": "ledger", "text": "review pool", "atCue": "review"}, {"anchor": "owner", "text": "packets + triager", "atCue": "Packets"}, {"anchor": "ops", "text": "alarms", "atCue": "alarms"}], "annotations": [{"kind": "box", "anchor": "queue", "atCue": "queue"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §4 A8-A13
- chip [our-framing] hand layout of the factory maps
- facts: R78

### r8-4-tools · HOW · explain · diagram · 6 s @ 8:21 · in: *and*

*origin:* `v4`

> Last come why, the restart pacer, evals and invariant tests, and your expedite entry.

- **Assertion:** why, a pacer, tests and your expedite
- **Job:** `map` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "pins": [{"anchor": "owner", "text": "why", "atCue": "why"}, {"anchor": "ledger", "text": "evals + tests", "atCue": "evals"}, {"anchor": "owner", "text": "expedite", "atCue": "expedite"}], "annotations": [{"kind": "box", "anchor": "broker", "atCue": "pacer"}]}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §4 A14-A18
- chip [our-framing] hand layout of the factory maps
- facts: R79

## Ladder · In what order?

### r9-1-ladder · HOW · explain · diagram · 7 s @ 8:27

*origin:* `v2`

> It ships as eleven rungs, each behind a flag or in shadow, naming what it deletes.

- **Assertion:** Eleven rungs, each reversible by a flag
- **Job:** `artifact-filling` · **Render:** `LadderBeat`
- cue `eleven` → V11 rung:M0–M10
- cue `flag` → V11 detail:flag or shadow
- cue `deletes` → V11 detail:names what it deletes
- chip [docs-claim] pipeline-redesign-2026-10-13.md §5
- facts: R48

### r9-2-first · HOW · explain · diagram · 9 s @ 8:34 · in: *then*

*origin:* `v2`

> Rung zero fixes data honesty, one shadows requirements and ships why, two adds the review queue, and three the merge queue.

- **Assertion:** Honest data, shadow, review queue, merge queue
- **Job:** `artifact-filling` · **Render:** `LadderBeat`
- cue `honesty` → V11 rung:M0|data honesty
- cue `shadows` → V11 rung:M1|shadow + why
- cue `review` → V11 rung:M2|review queue
- cue `merge` → V11 rung:M3|merge queue
- chip [docs-claim] pipeline-redesign-2026-10-13.md §5
- facts: R48

### r9-3-middle · HOW · explain · diagram · 7 s @ 8:43 · in: *then*

*origin:* `v2`

> Four wakes fixers, five shadows the adversary, six requires contracts, seven folds owner gates into one class.

- **Assertion:** Fixer wakes, adversary shadow, contracts, gates
- **Job:** `artifact-filling` · **Render:** `LadderBeat`
- cue `wakes` → V11 rung:M4|fixer wakes
- cue `adversary` → V11 rung:M5|adversary shadow
- cue `contracts` → V11 rung:M6|plan contract
- cue `class` → V11 rung:M7|one owner class
- chip [docs-claim] pipeline-redesign-2026-10-13.md §5
- facts: R48

### r9-4-late · HOW · explain · diagram · 10 s @ 8:50 · in: *then*

*origin:* `v2`

> Eight moves dispatch into the factory after a forty-eight-hour shadow, reversibly, in parallel: about fifty-five agent-hours. Nine adds the restart pacer; ten shrinks the charter.

- **Assertion:** Rung eight runs in parallel, reversibly
- **Job:** `artifact-filling` · **Render:** `LadderBeat`
- cue `dispatch` → V11 rung:M8|dispatch moves
- cue `forty-eight-hour` → V11 detail:48-h shadow, reversible
- cue `fifty-five` → V11 detail:M8 about 55 agent-hours
- cue `pacer` → V11 rung:M9|restart pacer
- cue `charter` → V11 rung:M10|charter shrink
- chip [docs-claim] pipeline-redesign-2026-10-13.md §5
- chip [estimated] pipeline-redesign-2026-10-13.md §6 R15
- chip [docs-claim] pipeline-redesign-2026-10-13.md §5 M8, §11 Q9
- facts: R48, R49, R50

## Your calls · What is open?

### r10-1-calls · WHAT · explain · takeaways · 5 s @ 9:00

*origin:* `v4`

> Eleven calls are yours, none technical, each with a default.

- **Assertion:** Eleven owner calls, each with a default
- **Job:** `numbers` · **Render:** `HookBeat`
- cue `Eleven` → V11 card:Q1 landing
- cue `Eleven` → V11 card:Q2 stopgap
- cue `Eleven` → V11 card:Q3 rules
- cue `Eleven` → V11 card:Q4 fix queue
- cue `Eleven` → V11 card:Q5 seats
- cue `Eleven` → V11 card:Q6 expedite
- cue `Eleven` → V11 card:Q7 sitting
- cue `Eleven` → V11 card:Q8 daily
- cue `Eleven` → V11 card:Q9 cutover
- cue `Eleven` → V11 card:Q10 policy
- cue `Eleven` → V11 card:Q11 research
- chip [docs-claim] pipeline-redesign-2026-10-13.md §11
- facts: R51

### r10-2-q1 · WHAT · explain · takeaways · 11 s @ 9:05 · in: *and*

*origin:* `v2`

> First, landing per repo. Option a: the token bypasses the ruleset and main fast-forwards to the tested candidate. Option b: API merges, a tree-hash check, the up-to-date rule off.

- **Assertion:** Q1: two ways to land, per repo
- **Job:** `alternatives-vs-ours` · **Render:** `CompareBeat`
- cue `bypasses` → V11 left:token on the bypass list
- cue `fast-forwards` → V11 left:main fast-forwards
- cue `API` → V11 right:API merges
- cue `tree-hash` → V11 right:tree-hash check
- cue `up-to-date` → V11 right:up-to-date rule off
- chip [docs-claim] pipeline-redesign-2026-10-13.md §11 Q1, §2.6 step 7
- facts: R52

### r10-3-q1-default · WHAT · explain · takeaways · 10 s @ 9:16 · in: *and*

*origin:* `v2`

> Under a, CI holds by construction; under b, for each batch's final tree only. Unanswered, b applies where that rule is off; other repos wait.

- **Assertion:** Q1: what each option guarantees
- **Job:** `alternatives-vs-ours` · **Render:** `ListBeat`
- cue `construction` → V11 row:(a) by construction
- cue `final` → V11 row:(b) final tree only
- cue `Unanswered` → V11 open:default: (b) where rule is off
- chip [docs-claim] pipeline-redesign-2026-10-13.md §11 Q1, §2.6 step 7
- facts: R52

### r10-4-q2-q4 · WHAT · explain · takeaways · 9 s @ 9:26 · in: *then*

*origin:* `v2`

> Two to four: confirm the stopgap, adopt the rule-file review rule, and keep fixes waiting on a delivered packet. Each default is yes.

- **Assertion:** Q2 to Q4 confirm earlier calls
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `stopgap` → V11 open:Q2 stopgap · build, delete at M3
- cue `rule-file` → V11 open:Q3 rule-file review rule
- cue `fixes` → V11 open:Q4 fixes wait after a packet
- cue `default` → V11 open:default: yes to each
- chip [docs-claim] pipeline-redesign-2026-10-13.md §11 Q2-Q4
- facts: R53

### r10-5-q5-q6 · WHAT · explain · takeaways · 8 s @ 9:35 · in: *then*

*origin:* `v2`

> Five: which seat partitions run, by default lead-desk's alone. Six: a console expedite, by default added at rung eight.

- **Assertion:** Q5 and Q6: seats and your expedite
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `partitions` → V11 open:Q5 seats on at M8
- cue `default` → V11 open:default: lead-desk only
- cue `expedite` → V11 open:Q6 console expedite
- cue `added` → V11 open:default: add at M8
- chip [docs-claim] pipeline-redesign-2026-10-13.md §11 Q5-Q6
- facts: R54

### r10-6-q7-q9 · WHAT · explain · takeaways · 10 s @ 9:43 · in: *then*

*origin:* `v4`

> Seven: a blind sitting on real packets. Eight: a daily line, not alarms. Nine: a shadow run before a reversible cutover. The defaults: schedule, daily line, accept.

- **Assertion:** Q7 to Q9: your time, alarms, cutover
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `blind` → V11 open:Q7 blind sitting
- cue `daily` → V11 open:Q8 daily line
- cue `shadow` → V11 open:Q9 shadow bar
- cue `reversible` → V11 row:cutover is reversible
- chip [estimated] pipeline-redesign-2026-10-13.md §11 Q7-Q9
- chip [docs-claim] pipeline-redesign-2026-10-13.md §5 M8, §11 Q9
- facts: R55, R50

### r10-6b-q10-q11 · WHAT · explain · takeaways · 9 s @ 9:53 · in: *then*

*origin:* `v4`

> Ten: two pool rules replace the weighted score, tried in shadow first. Eleven: four researchers study the pattern first. Both defaults are yes.

- **Assertion:** Q10 and Q11: pool rules and research
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `Ten` → V11 open:Q10 pool rules for the score
- cue `Eleven` → V11 open:Q11 research fan-out
- cue `defaults` → V11 open:default: yes to both
- chip [docs-claim] pipeline-redesign-2026-10-13.md §11 Q10-Q11
- facts: R80

### r10-7-followups · WHAT · explain · takeaways · 6 s @ 10:02 · in: *and*

*origin:* `v2`

> Eight follow-ups settle the technical forks, from F1's queue age to F13's landing test.

- **Assertion:** Eight follow-ups settle the technical forks
- **Job:** `numbers` · **Render:** `HookBeat`
- cue `Eight` → V11 card:F1 queue age
- cue `Eight` → V11 card:F3 roster
- cue `Eight` → V11 card:F4 gates
- cue `Eight` → V11 card:F7 release
- cue `Eight` → V11 card:F9 notices
- cue `Eight` → V11 card:F11 poller
- cue `Eight` → V11 card:F12 overlaps
- cue `Eight` → V11 card:F13 landing
- chip [docs-claim] pipeline-redesign-2026-10-13.md §6; system-review-2026-10-13.md follow-up table
- facts: R56

### r10-7b-research · WHAT · explain · takeaways · 8 s @ 10:08 · in: *and*

*origin:* `v4`

> Research comes first: durable engines, build-system memoization, waits and claims, and an audit of our own engine, one researcher each.

- **Assertion:** Four researchers report before the next round
- **Job:** `artifact-filling` · **Render:** `ListBeat`
- cue `engines` → V11 row:R-A engines
- cue `memoization` → V11 row:R-B build memo
- cue `waits` → V11 row:R-C waits + claims
- cue `audit` → V11 row:R-D engine audit
- chip [docs-claim] pipeline-redesign-2026-10-13.md §12
- facts: R81

### r10-8-measures · WHAT · explain · takeaways · 9 s @ 10:16 · in: *so*

*origin:* `v4`

> Measures: how fast why answers, how many asks are superseded, how many reviews end with no verdict. Latency has no target until F1.

- **Assertion:** Three measures, and latency waits for F1
- **Job:** `numbers` · **Render:** `ScorecardTable`
- cue `why` → V11 measure:why answer|not measured|under 5 s
- cue `superseded` → V11 measure:superseded asks|69%|under 10%
- cue `no` → V11 measure:no-verdict|16%|under 5%
- cue `F1` → V11 measure:latency|not set|after F1
- chip [target] pipeline-redesign-2026-10-13.md §1
- facts: R57

### r10-9-close · CLOSE · explain · hook · 11 s @ 10:25 · in: *so*

*origin:* `v4`

> In this design, a recipe is a script, each step leaves a marker, and recovery is a re-run from the top. Every wait names its reason. The open calls are yours.

- **Assertion:** Every wait names its reason
- **Job:** `cast-in-motion` · **Render:** `StationMap`
- **Layout:** `hand` · edges `design`
- **map_state:** `{"map": "new", "level": "containers", "camera": {"fit": "all", "atCue": "design"}, "annotations": [{"kind": "box", "anchor": "ledger", "atCue": "marker"}], "message_in_flight": {"flow": "flow:item", "fromHop": 0, "toHop": 8, "atCue": "re-run"}}`
- chip [docs-claim] pipeline-redesign-2026-10-13.md §2.3
- chip [our-framing] hand layout of the factory maps
- facts: R64

### r10-10-outro · CLOSE · explain · hook · 4 s @ 10:36 · in: *so*

*origin:* `v2`

> Find the wake, and you find the wait.

- **Assertion:** Find the wake, find the wait
- **Job:** `numbers` · **Render:** `OutroBeat`
- cue `wake` → V11 title:find the wake
- facts: —

## Facts pack

| Id | Claim | Source | Status |
|---|---|---|---|
| R01 | One task's state lives in four stores (task file, burndown.json, broker roster and events.db, factory.sqlite3); two orchestrators, the tick and Shepherd, join them by polling and calling each other's CLIs | `adversarial-review-2026-10-13.md §1` | measured |
| R02 | The tick summary read `claimed` 143 against about 60 real claims | `adversarial-review-2026-10-13.md §1; system-review-2026-10-13.md B2` | measured |
| R03 | A DONE report is seen by the ledger up to 13 min late (tick period plus runtime) | `adversarial-review-2026-10-13.md §1; system-review-2026-10-13.md line 252` | estimated |
| R04 | Shepherd's reviewer asks time out in batches (ReviewerAskTimedOut); the roster read as their cause is inferred | `adversarial-review-2026-10-13.md §1, §5.5; pipeline-redesign-2026-10-13.md §9` | estimated |
| R05 | 1,626 Shepherd-to-seat messages; 313 held fix rounds relayed for a hand resume in two weeks | `pipeline-redesign-2026-10-13.md §9; adversarial-review-2026-10-13.md §1, §2 row 1` | measured |
| R06 | The tick re-registers PRs with Shepherd as a backstop | `adversarial-review-2026-10-13.md §2 row 7; pipeline-redesign-2026-10-13.md §3.4` | docs-claim |
| R07 | Seven jobs: choose, make, prove, land, keep going, ask the owner, be legible | `pipeline-redesign-2026-10-13.md §2.1` | docs-claim |
| R08 | Seven invariants I1-I7; the mechanism is open, the invariant is not | `pipeline-redesign-2026-10-13.md header` | docs-claim |
| R09 | Fixed constraints: no webhooks reach the box so GitHub is polled; 20 runner slots (314(b)); agents crash, stall and mis-report; the owner is asked rarely and well | `pipeline-redesign-2026-10-13.md header` | docs-claim |
| R10 | Compensating mechanisms 20 today, target under 5; clocks 5 to 1; stores of work state 4 to 1 plus the task file as the owner's view | `pipeline-redesign-2026-10-13.md §1; adversarial-review-2026-10-13.md §2` | target |
| R13 | The scheduler is a pure function run on every event, never sleeps; the reconciler is the only clock, a GitHub poller (30-60 s, ETags), a backstop | `pipeline-redesign-2026-10-13.md §2.3` | docs-claim |
| R14 | agent-chat becomes a runtime: spawns, supervises, owns no work state; agents are short-lived | `pipeline-redesign-2026-10-13.md §2.6 (after step 9)` | docs-claim |
| R15 | The owner's attended session is the console: reads packets, files expedites; the ops seat is an alarm sink, not the owner | `pipeline-redesign-2026-10-13.md §2.5, §10.5` | docs-claim |
| R17 | Plan: slices with a contract (risk class, requirements, DELTA sentence, probes, contract paths); lint refuses a plan without one; the owner approves contracts and rule sentences in the plan sitting | `pipeline-redesign-2026-10-13.md §2.6 step 1` | docs-claim |
| R21 | Raise-only class: a reviewer that sees a security touch emits ClassRaised, adding adversary:merge@h from a second reviewer on another profile or account; nobody can lower a class | `pipeline-redesign-2026-10-13.md §2.2, §2.6 step 4` | docs-claim |
| R23 | Owner: owner:approved@h opens only when the class says so, at a settled head, with an agent-written packet; it cancels if the head moves before delivery | `pipeline-redesign-2026-10-13.md §2.6 step 6` | docs-claim |
| R24 | After delivery, fix rounds queue behind the owner's answer (310(b) Q2); a rule file asks live only for a looser or mixed DELTA, table.json or a ruleset | `pipeline-redesign-2026-10-13.md §2.6 step 5, §2.7` | docs-claim |
| R25 | Merge queue: a candidate of main plus ready heads, CI once, main lands at that tree; the PR head never moves (I2 by construction) | `pipeline-redesign-2026-10-13.md §2.6 step 7` | docs-claim |
| R26 | Main CI is a confirmation; a red main gets one main-red fixer from the tip; landed retires agents; the task closes when every slice has landed | `pipeline-redesign-2026-10-13.md §2.6 steps 8-9` | docs-claim |
| R27 | Stalls: LeaseExpired, up to three re-drives, then a triager with a fixed verdict (RESTART, FILE-DEFECT + PARK, ESCALATE-OPS); the owner sees one daily line | `pipeline-redesign-2026-10-13.md §2.5` | docs-claim |
| R28 | Two-deep hold slots with per-class release become requirements per head | `pipeline-redesign-2026-10-13.md §3.2` | docs-claim |
| R29 | Merge-ups are 30-35% of PR heads and about a quarter of runner minutes | `pipeline-redesign-2026-10-13.md §9` | measured |
| R30 | The 600-s tick and 30-s kick become event handlers plus the reconciler | `pipeline-redesign-2026-10-13.md §3.4` | docs-claim |
| R31 | Guard-deny-only classes release on conformance (341(2), 350 S7b-1); other adversary classes by software only after F7; until then the seat or owner releases | `pipeline-redesign-2026-10-13.md §10.7, §3.5` | docs-claim |
| R32 | Review is a pull queue: a freed reviewer token pulls the highest-priority ready head, red-main fixers first | `pipeline-redesign-2026-10-13.md §2.3` | docs-claim |
| R33 | hitl_gate, 7 days: 482 of 717 gates cancelled, 302 because the head moved, about 130 landed elsewhere | `pipeline-redesign-2026-10-13.md §9; adversarial-review-2026-10-13.md §2` | measured |
| R34 | Seat duties go to the scheduler and triager; a seat is a config partition the owner switches; lead-desk becomes the ops alarm sink | `pipeline-redesign-2026-10-13.md §8 ch 6, §2.6, §10.5` | docs-claim |
| R35 | Risk class moves to the planner's contract; the implementer's flag can raise, never lower | `pipeline-redesign-2026-10-13.md §2.6 step 1, §3.4` | docs-claim |
| R36 | The owner moves to the plan sitting (contracts, rule sentences) and the console (expedites, looser-or-mixed packets) | `pipeline-redesign-2026-10-13.md §8 ch 6` | docs-claim |
| R37 | Shepherd steps become registered steps; burndown becomes a recipe (316); agent-chat becomes a runtime | `pipeline-redesign-2026-10-13.md §8 ch 6, §2.6` | docs-claim |
| R38 | The seven carry modules and 341(1)'s stopgap are deleted at M3; I2 holds because the queue never moves a head | `pipeline-redesign-2026-10-13.md §3.1, §5 M3` | docs-claim |
| R39 | Hold slots, the no-reviewer hold and defect gates are replaced by per-head requirements, leases, re-drives and the triager (347(3)) | `pipeline-redesign-2026-10-13.md §3.1-§3.3` | docs-claim |
| R40 | Role caps become pools; three hard stops: five-hour ceiling, seven-day reserve line, per-run cap (322); I4 | `pipeline-redesign-2026-10-13.md §2.2, §3.4` | docs-claim |
| R41 | Under 1% of park refusals were acted on (678 sent) | `pipeline-redesign-2026-10-13.md §9; system-review-2026-10-13.md B16` | measured |
| R42 | The open-PR lock is replaced by declared contract paths plus optimistic integration, after F12; no standing coordinator in the loop | `pipeline-redesign-2026-10-13.md §3.4, §6 R6, §10.5` | docs-claim |
| R43 | After Round 3 the adversary has no blocking objection and records three residual risks | `adversarial-review-2026-10-13.md Round 3` | docs-claim |
| R44 | Residual risk 1: rule-file conformance with no checker is an agent's judgement; a disguised loosening would skip the live packet; the adversary must still MERGE | `adversarial-review-2026-10-13.md Round 3 item 1` | docs-claim |
| R45 | Residual risks 2-3: every big claim waits on its follow-up; until M8, two orchestrators remain | `adversarial-review-2026-10-13.md Round 3 items 2-3` | docs-claim |
| R46 | Seat-only adversary catches 6-10, 2 security-relevant | `pipeline-redesign-2026-10-13.md §9; adversarial-review-2026-10-13.md §5.8` | measured |
| R47 | 18 additions, A1-A18, shown in twelve groups | `pipeline-redesign-2026-10-13.md §4, §8 ch 8` | docs-claim |
| R48 | Ladder M0-M10: each rung behind a flag or in shadow, rolled back by its flag, naming its deletions | `pipeline-redesign-2026-10-13.md §5` | docs-claim |
| R49 | M8 (the 316 port) is about 55 agent-hours on its critical path; M1-M7 go first, M8 in parallel | `pipeline-redesign-2026-10-13.md §6 R15` | estimated |
| R50 | M8 cutover after a 48-h A+B+C shadow with no unexplained diff; reversible | `pipeline-redesign-2026-10-13.md §5 M8, §11 Q9` | docs-claim |
| R51 | Eleven owner decisions Q1-Q11, none technical, each with a default if unanswered | `pipeline-redesign-2026-10-13.md §11` | docs-claim |
| R52 | Q1 landing shape per repo: (a) bypass and fast-forward, I1 by construction; (b) up-to-date rule off, API merges, tree-hash check, final tree only; default (b) where the rule is off, else the repo waits | `pipeline-redesign-2026-10-13.md §11 Q1, §2.6 step 7` | docs-claim |
| R53 | Q2 confirm the 341(1) stopgap built flagged, deleted at M3; Q3 adopt the rule-file review rule; Q4 keep fixes queued behind a delivered packet; defaults build, adopt, keep | `pipeline-redesign-2026-10-13.md §11 Q2-Q4` | docs-claim |
| R54 | Q5 seat partitions on at M8, default lead-desk only; Q6 console expedite entry, default add at M8 | `pipeline-redesign-2026-10-13.md §11 Q5-Q6` | docs-claim |
| R55 | Q7 owner-blind sitting, about 45 minutes, 30 packets, default schedule after the packets are built; Q8 daily line, default daily line; Q9 48-h shadow bar, reversible, default accept | `pipeline-redesign-2026-10-13.md §11 Q7-Q9` | estimated |
| R56 | Follow-ups F1, F3, F4, F7, F9, F11, F12, F13 settle the technical forks | `pipeline-redesign-2026-10-13.md §6; system-review-2026-10-13.md follow-up table` | docs-claim |
| R57 | Measures: why in under 5 s; superseded owner asks 69% to under 10%; no-verdict 16% to under 5%; latency targets only after F1 | `pipeline-redesign-2026-10-13.md §1` | target |
| R58 | Seven nouns: work item, fact, step, wait and claim, event, pool, service | `pipeline-redesign-2026-10-13.md §2.2` | docs-claim |
| R59 | One sentence: a recipe is a script; a step is memoized at its head; a wait or claim is a return; an event re-enters the script | `pipeline-redesign-2026-10-13.md §1, §8 ch 3` | docs-claim |
| R60 | Landed runs average 51.5 steps (p50 47, max 270) and 81.7 KB of step results, over 1,677 landed runs | `research/R-D-2026-10-13.md §0 item 6` | measured |
| R61 | Today's memo key is step name plus call count; 5 parked runs went recovery_required on 10-10 after a deploy re-keyed sh-held-check and left counter-keyed results unread (TP-2697) | `research/R-D-2026-10-13.md §0 items 1-2, §5.1; pipeline-redesign-2026-10-13.md §9` | measured |
| R62 | 2 deploy rollbacks on tick-judged health (TP-2846); the outbox's intent names the window and the result is judged once at its end | `pipeline-redesign-2026-10-13.md §9, §2.3` | measured |
| R63 | One runner runs an item's recipe from the top on every event over one marker table; the reconciler, a GitHub poller, is the only clock | `pipeline-redesign-2026-10-13.md §2.3, §1, §4 A1, A3, A7` | docs-claim |
| R64 | No stored program counter: recovery after a crash, restart or deploy runs from the top; valid markers return at once, so the script fast-forwards to its first missing marker | `pipeline-redesign-2026-10-13.md §2.3` | docs-claim |
| R65 | Waits are returns, not sleeps: a serve restart finds nothing mid-sleep | `pipeline-redesign-2026-10-13.md §2.3` | docs-claim |
| R66 | An inserted step has no marker, so it runs; existing markers still match | `pipeline-redesign-2026-10-13.md §2.3 Versioning` | docs-claim |
| R67 | A changed upstream marker invalidates the markers that read it (input digests); agent steps are invalidated only by head and version | `pipeline-redesign-2026-10-13.md §2.3 Validity` | docs-claim |
| R68 | A grant is a marker; on re-entry an invalid grant releases its token before any upstream step re-runs | `pipeline-redesign-2026-10-13.md §2.4 Grant, §2.3` | docs-claim |
| R69 | Start: the recipe claims an implementer and returns; the pool's policy picks which claim to grant; the broker spawns the implementer | `pipeline-redesign-2026-10-13.md §2.6 step 2, §2.4` | docs-claim |
| R70 | Open: the implementer pushes; the reconciler emits the event; the step records the head; globs can raise the class | `pipeline-redesign-2026-10-13.md §2.6 step 3` | docs-claim |
| R71 | Prove: CI and fix-proof are reads of the reconciler's events; verdicts are claims on the reviewer pool, met by short-lived reviewers | `pipeline-redesign-2026-10-13.md §2.6 step 4` | docs-claim |
| R72 | Fix: a red fact wakes the implementer at once; a push resets head-pinned facts | `pipeline-redesign-2026-10-13.md §2.6 step 5, §2.2` | docs-claim |
| R73 | Landing is an irreversible step: an intent marker before the call and a result marker after; main lands at the tested tree | `pipeline-redesign-2026-10-13.md §2.6 step 7, §2.3` | docs-claim |
| R74 | Two pool rules replace the weighted score: finish before start; tier, then readiness age | `pipeline-redesign-2026-10-13.md §2.4 Policy, §11 Q10` | docs-claim |
| R75 | Left out of the video: pool policy details, risk table rows and stacking; each is data in a table, a policy or a plan | `pipeline-redesign-2026-10-13.md §2.4, §2.6 steps 1-2, §2.7` | docs-claim |
| R76 | Core additions: marker table, step registry, runner; waits and the event index | `pipeline-redesign-2026-10-13.md §4 A1-A4` | docs-claim |
| R77 | Claims and pools; the outbox step kind; the reconciler service | `pipeline-redesign-2026-10-13.md §4 A5-A7` | docs-claim |
| R78 | Risk table and contract; review pool and merge queue; packets, triager and alarms | `pipeline-redesign-2026-10-13.md §4 A8-A13` | docs-claim |
| R79 | why; the restart pacer; evals and invariant tests; the owner's expedite entry | `pipeline-redesign-2026-10-13.md §4 A14-A18` | docs-claim |
| R80 | Q10 pool policy replaces the weighted score, adopted in shadow first; Q11 the research fan-out runs; default yes to both | `pipeline-redesign-2026-10-13.md §11 Q10-Q11` | docs-claim |
| R81 | Research fan-out: R-A durable engines, R-B build-system memoization, R-C waits and claims, R-D an audit of today's engine | `pipeline-redesign-2026-10-13.md §12` | docs-claim |
