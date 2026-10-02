# Shepherd: from a registered PR to a merge

Shepherd is the `shepherd-pr` workflow inside the [factory](/guides/factory) and the
`titan-factory shepherd` verbs that drive it. You register a pull request, or a branch whose
pull request is not open yet. Shepherd then waits for CI, keeps the branch current, asks for
the merge decision its policy requires, merges the exact approved head, and reads main CI on
the merge commit.

Read [what is not built yet](#what-is-not-built-yet) before you rely on it. The review phase
runs only when `shepherd.review` is configured. Without it, every Shepherd merge waits for
the owner.

## Prerequisites

Everything in the [factory guide](/guides/factory#prerequisites): a built checkout, `gh`
logged in, and a base branch with at least one required check. Run `titan-factory serve` so
runs stay alive after your shell exits. Each verb below calls the server when one answers on
`--port` (default 7410) and opens the database directly when none does. Every verb takes
`--json` to print the result object instead of the one-line form.

## Register

```sh
titan-factory shepherd register owner/repo#123 --task initiative/42 --implementer impl-1
titan-factory shepherd register owner/repo --branch feat/example --task initiative/42 --implementer impl-1
```

```
run ab0f9228-… shepherd-pr owner/repo (feat/example): started; policy owner-gate
```

`--task` and `--implementer` are required. The target is `owner/repo#N`, or `owner/repo`
with `--branch`. The other flags:

| Flag | Meaning |
| --- | --- |
| `--reviewer <name>` | the agent that reviews |
| `--kind <kind>` | `correctness`, `security`, `feature`, `refactor` or `unknown` (the default) |
| `--policy <json>` | narrows the seat policy; see [seat policy](#seat-policy) |

Registration is idempotent (`products/factory/src/shepherd/commands.ts`). A repeat for the
same `repo#pr`, or for the pull request's head branch, updates the task, implementer,
reviewer, kind and policy on the existing registration and returns the same run:

```
run ab0f9228-… shepherd-pr owner/repo (feat/example): already registered, metadata updated; policy never
```

A branch registered first and its pull request registered later share one run. A
registration by number reads the pull request from GitHub to learn its head branch, so it
needs `gh`. A `--branch` that is not the pull request's head is refused.

With no server running, the run is recorded and the verb says so on stderr:
`no titan-factory serve answered on port 7410, so the run was recorded here; titan-factory
serve drives it`.

## Phases

```mermaid
graph LR
  awaitingPr["awaiting-pr"] --> ci
  ci --> review
  ci --> fixing
  fixing --> ci
  review --> approval["awaiting-approval"]
  approval --> merging
  merging --> postMerge["post-merge"]
  postMerge --> done
```

A phase is a view over the run's current step (`products/factory/src/shepherd/view.ts`).

| Phase | The run is |
| --- | --- |
| `awaiting-pr` | polling every 30 seconds for a pull request on the registered branch, with no timeout |
| `ci` | reading branch rules, waiting for required checks, updating a branch that is behind, or rerunning a cancelled run |
| `fixing` | waiting for a new head after a human chose to await a fix |
| `review` | reading the review verdict and the registration's policy for a green head |
| `awaiting-approval` | recording the merge decision, or waiting on a gate: `approve-merge`, `ci-failed`, `sh-sent-back` or `stuck-behind` |
| `merging` | merging the approved head; a held pull request, or one waiting for the [merge train](#merge-train), waits here |
| `post-merge` | reading main CI on the merge commit, for up to 60 minutes, then [freezing on red or thawing on green](#after-the-merge) |
| `done`, `failed`, `cancelled` | finished |

A `done` run did not necessarily merge. A run that stops unmerged (closed, abandoned,
merge-denied, stuck-behind, not-mergeable, conflict) records an `sh-stopped` step with the
reason, and the `WatchRow` `outcome` field reads `merged` or `stopped` with that reason.

Shepherd runs no deploy, release or activation stage and does not run the factory's
`postMerge` chore.

## After the merge {#after-the-merge}

The `sh-main-ci` step reads main CI on the merge commit once, for up to 60 minutes. What
happens next depends on the verdict (`products/factory/src/shepherd/post-merge.ts` and
`main-red.ts`).

A run at the merge commit that concurrency cancelled because a newer main push superseded
it is not red. When every failed run was cancelled and main's tip is a later push that
contains the merge commit, Shepherd reads CI at that tip instead (`MAIN_CI_ROUTES` in
`products/factory/src/shepherd/route-table.ts`). A cancelled run with no newer push is red.

**Unread.** No run appeared at the merge sha. The run opens `main-red` and freezes nothing.

**Red.** The run freezes the repo, then works through three steps:

1. `sh-freeze` freezes the repo at the merge sha. A freeze is one row per repo; a red in a
   live freeze counts up, and a red after a thaw starts a new episode.
2. `sh-file-fix-task` files one high-severity active-work task per episode, over
   active-work's loopback rpc (`127.0.0.1:$AW_PORT`, default 7400). The task goes into the
   initiative of the merged pull request's `--task` when that reads `<initiative>/<id>`, and
   into `titan-platform` otherwise. It carries the failing jobs and their fenced log tails,
   and is tagged with a key built from the repo and the merge sha, so a replay after a crash
   finds it instead of filing a second one. A daemon that is down is retried for up to 60
   minutes.
3. `sh-spawn-fixer` spawns one fixer per episode, if the run's policy grants `fixer`. The
   grant holds when a seat lists the repo and `--policy` does not set `"fixer":false`. The
   fixer is an agent-chat agent on the `implementer` profile, named
   `fix-<repo>-<short merge sha>`, started in the repo's seat checkout. Its brief tells it to
   register its fix pull request with the fix task and with itself as `--implementer`. It
   needs `shepherd.agentChatBin` in the [config file](/guides/factory#the-config-file).

Both steps write only to the episode `sh-freeze` returned. If the repo thaws while a step
waits, the step files or spawns nothing more, records nothing, and the run moves on to
cleanup without a gate. That holds even if a new red has frozen the repo again. A fixer
already spawned by then is reported in the step's detail and keeps running.

While the repo is frozen, every merge route waits in `merging`, the same way a hold does.
One pull request is exempt: the one whose registration names the episode's fix task and
the episode's fixer as its implementer. The guard also re-reads the default branch at most
every five minutes, and a green head there thaws the repo.

**Green.** `sh-unfreeze` thaws a frozen repo when the merge commit descends from the red sha
and every check that was red there ran green again. A path filter that skips a red check
therefore cannot thaw it.

Every outcome that leaves the repo frozen with nothing in place to clear it opens a gate
with the owner's release on offer:

- `main-red-again`: main went red while the episode already had a fixer, the fixer's own
  merge included. No second fixer is spawned.
- `main-frozen`: no fix task was filed, no fixer was spawned (notify-only policy, no
  agent-chat, no checkout, or a failed spawn), or a green merge left the repo frozen.

The answer is `{"decision":"stay-frozen"|"unfreeze","mergeSha":"<merge sha>"}`. `unfreeze`
thaws only the episode the gate opened for. If the repo has thawed and frozen again since,
the answer changes nothing. Each run opens its own gate, so one episode can leave several
open; answer any one with `unfreeze` and the rest go stale.

## Routing a reviewed head {#routing}

After the review of a green head, the `sh-observe` step reads the pull request again, and one
table decides what happens next (`products/factory/src/shepherd/route-table.ts`). The table
is keyed by three things: whether the pull request is still open, GitHub's
`mergeable_state`, and what the review came to. Every cell has a route, and a test fails if
one is missing.

| State at `sh-observe` | `MERGE` | `FIX_FIRST` | no verdict, or the wait ran out | hold's reviewer has not answered |
| --- | --- | --- | --- | --- |
| `clean`, `blocked`, `unstable`, `has_hooks` | merge decision | wake the fixer | fresh reviewer | read the hold's reviewer again |
| `behind` | update the branch, new round | wake the fixer | update the branch, new round | update the branch, new round |
| `dirty` | wake the fixer | wake the fixer | wake the fixer | wake the fixer |
| `unknown` | new round | wake the fixer | new round | new round |
| `draft` | end the run | wake the fixer | end the run | end the run |

A head that moved during the review always starts a new round, and the new head is reviewed.
A pull request merged or closed outside Shepherd ends the run: a merge goes on to the
post-merge read, a close stops. `titan-factory serve` also checks, every 5 minutes, the pull
request of each run that is waiting on a gate. When that pull request was merged or closed
elsewhere, the serve process cancels the run and its gate.

A reviewer that misses the 30-minute wait is read again before Shepherd gives up on it. The
`sh-late-verdict` step reads that reviewer's final message until it holds a verdict at the
head, the reviewer has exited, or 10 minutes pass. A reviewer held up by a permission prompt
that writes `Verdict: MERGE` after the deadline is therefore read as MERGE, and its merge
goes through the evidence step like any other.

A fresh reviewer is spawned under a name nobody has held, and a standing reviewer is not
resumed. A run held with `hold --reviewer <name>` starts no reviewer of its own. It takes the
newest verdict that reviewer gave at the head, so a `FIX_FIRST` from it wakes the
implementer. Shepherd never reads a reviewer's name out of the hold's reason text.

`approve-merge` opens for four reasons only, and its prompt names the reason:

- `shepherd-route/conflict`: a merge conflict survived one fixer attempt. Answer `merge` to
  have Shepherd land the next resolved head, or `abandon`.
- `shepherd-route/failed-rounds`: 3 review rounds failed at this task. Only a stuck round
  counts: a fresh reviewer after silence or a timeout, a re-read of a hold's reviewer, or a
  conflict. A `FIX_FIRST` that yields a new head is progress and does not count.
- `shepherd-route/fix-first-runaway`: 6 `FIX_FIRST` reviews at this task.
- a policy that did not allow an automated merge, such as an `owner-gate` seat or an unmet
  `MRG-AU-RV` fact. The prompt starts `the authority policy did not allow an automated merge`.

Each `FIX_FIRST` wake records one `sh-wake-fix-first` step, so the run counts them across
every head it sees. After the first, every review is a re-review: its brief requires a
section that starts `Defect class:`, which names the defect class that recurs across the
rounds and the one boundary where a single fix covers every instance. From the second
`FIX_FIRST` on, the fixer gets a structural brief instead of another patch round. The brief
carries the reviewer's defect-class section and the whole findings verbatim, so every
blocking item reaches the fixer. A re-reviewer that leaves the section out still gives a
valid verdict. The fixer is then asked to name the class itself before fixing. The brief is
built from the verdict alone, and nothing can trim it before the wake.

A woken implementer must start a turn within 5 minutes: a new event in its transcript, or a
new head. A live implementer is messaged through `agent-chat debug send`, which delivers the
message as if the human sent it until agent-chat adds a `shepherd` wake source (CC-436). An ended one
is resumed or replaced by a successor. If no turn starts, one fallback goes out: a resume if
the agent has ended by then, else a second message. If there is still no turn, the wake is
unhandled.

GitHub refuses `update-branch` with HTTP 422 `merge conflict between base and head` when the base
cannot merge into the head. That is not a failure: the land round stops with reason `conflict` and
takes the same route as a `dirty` PR. The first time, the implementer is woken with the conflict;
if the conflict is still there on the next `update-branch`, `approve-merge` opens with
`shepherd-route/conflict`. Any other `update-branch` error still fails the step.

When a run reads a new head, it cancels its own pending `approve-merge` and `sh-sent-back` gates
whose prompt names an older head. A gate at the current head stays pending.

## Watch

```sh
titan-factory shepherd status                  # every registration
titan-factory shepherd status owner/repo       # one repo
titan-factory shepherd status owner/repo#123   # one pull request
titan-factory shepherd list --state all        # active (default), finished or all
titan-factory shepherd timeline owner/repo#123
```

```
owner/repo#123 ci 1a2b3c4 waiting for CI on 1a2b3c4
owner/repo feat/example awaiting-pr - waiting for a PR on the registered branch
```

Each line is the target, the phase, the short head, the next action, and any blockers in
brackets: `held: <reason>` or `stalled: <reason>`. Only a failed or parked run reads as
stalled; there are no per-phase time limits yet. With nothing registered the verbs print
`no shepherded PRs`. `timeline` prints the same row and then every step, CI read and gate
the run recorded, oldest first. `--json` returns the `WatchRow` and `PrTimeline` shapes the
factory UI reads.

## Seat policy {#seat-policy}

Every registration resolves a policy before anything starts
(`products/factory/src/shepherd/policy.ts`). The merge mode is one of three:

| Mode | Effect |
| --- | --- |
| `never` | the merge decision is `deny` and the run stops |
| `owner-gate` | every merge waits on the `approve-merge` gate |
| `auto` | a merge may go through without the owner when the authority row holds; otherwise it gates |

The ceiling comes from seat files. A repo that no seat lists gets `owner-gate`. A seat whose
`grants_extra` includes `merge-on-green-approve` raises the ceiling to `auto`. `--policy`
can only narrow the ceiling, never widen it: `{"merge":"auto"}` on an unlisted repo still
resolves to `owner-gate`. The other `--policy` keys are `mergeMethod` (`merge`, `squash` or
`rebase`; default `squash`), `reviewer`, `priority` and `fixer`. An unknown key is refused.

Seat files are read from `shepherd.seatsDir` in the
[config file](/guides/factory#the-config-file): every `*.md` file there, frontmatter only
(`products/factory/src/shepherd/seats.ts`).

```markdown
---
schema: autonomy-seat/v1
name: platform
repos:
  - path: ~/projects/example-repo
    remote: owner/example-repo
deny_repos:
  - ~/projects/dotfiles
grants_extra:
  - merge-on-green-approve
---
```

- **`repos`** lists the remotes the seat owns. A remote that several seats list gets only
  the grants they all share.
- **`deny_repos`** lists checkout paths no registration may target. A deny path that a seat
  binds to a remote denies that remote. A path no seat binds denies its last segment as a
  repo name under any owner.
- **Charter hard stops.** `shepherd.charterPath` names an `autonomy-charter/v1` file with a
  `hard_stops` list. `shepherd.hardStopRepos` maps a hard-stop id to the remotes it forbids.
- A deny wins over any seat. The refusal is
  `registration refused: owner/repo is on a seat deny list or a charter hard stop`, and no
  run starts.

The seat book is read again on every `register`, so a change applies without a restart. An
invalid seat file or charter fails every registration until it is fixed. Path spelling
rules are in the
[product README](https://github.com/HJewkes/titan-platform/blob/main/products/factory/README.md#shepherd-seat-paths).

The run re-reads its registration's policy before every merge decision and keeps the
stricter of the two. A later `register` can tighten a running pull request's policy. It
cannot loosen it.

## Hold and release

```sh
titan-factory shepherd hold owner/repo#123 --reason "waiting on a schema decision"
titan-factory shepherd hold owner/repo#123 --reason "security audit" --reviewer sec-audit-review
titan-factory shepherd release owner/repo#123
```

```
run ab0f9228-…: held (waiting on a schema decision)
run ab0f9228-…: released
```

A hold does not stop the run. CI waits, branch updates and gates carry on. The hold blocks
the merge call itself: every merge route reads the hold first, and a held pull request waits
in `merging`, polling every 10 seconds, until `release`
(`products/factory/src/shepherd/hold.ts`). The check covers `land-pr` too, so
`titan-factory land` on a held pull request also waits. Both verbs take `owner/repo#N`, so a
branch registration can be held only once its pull request exists. `--reviewer` names the
reviewer whose verdict the run waits for; `release` clears it. A merge that waited on a hold
does not go through on release: land reads CI again first, because the base may have moved.

## Merge train {#merge-train}

Per repo, one Shepherd run at a time is in the land sequence: update the branch if it is
behind, wait for green required checks at the new head, merge, then let the next run in
(`products/factory/src/shepherd/train.ts`). Without it, two pull requests approved at once
both reach the merge; the first merge puts the second behind its base, and the second merge
fails.

A run boards the train at its first merge step, after review and the merge decision. If
another run holds the train, it waits in `merging`, polling every 10 seconds, and `status`
names the run it waits behind:

```
owner/repo#124 merging 4d5e6f7 waiting for the merge train behind run ab0f9228-… (#123)
```

A run that has just boarded merges at once only when the train was free and its head is
current. Otherwise land reads CI again, so a branch the last merge put behind is updated
while the run holds the train. The run gives the train up in the `sh-train-leave` step when
its land round ends: merged, red CI, a send-back, or a conflict. A red head goes to the fixer
after the train has moved on.

The holder is a row in the `shepherd_train` table, so a restarted `titan-factory serve`
resumes the holder's run and it keeps the train. A waiting run takes the train over when the
holder's run is no longer running: failed, cancelled, parked for recovery, or paused on an
owner gate. It also takes it over when the holder's own merge is held, frozen or waiting on
the Version Packages pull request, so a hold never wedges the repo. Only `shepherd-pr` runs
ride the train; `titan-factory land` does not. A holder still waits through the review of
the head its update produced.

## The Version Packages pull request {#version-packages}

The changesets action opens a "Version Packages" pull request from `changeset-release/main`.
Shepherd lands it with no human step (`products/factory/src/shepherd/release.ts` and
`version-packages.ts`):

1. **Registered by a sweep.** Every minute, `titan-factory serve` looks for an open pull
   request from `changeset-release/main` in each repo Shepherd watches. It registers one it
   has not seen, with task `<repo>/version-packages`, implementer `changesets` and no fixer. A
   finished run gives up its claim on the branch, so the next release registers too.
2. **CI started by Shepherd.** The changesets action pushes with `GITHUB_TOKEN`, which starts
   no workflow. When the head has no Actions run and is at least 2 minutes old, the sweep
   pushes one empty commit onto the branch through `pushEmptyCommit`. It never pushes onto an
   empty commit, so Actions being down costs one commit, not one per sweep. The GitHub App of
   TP-447 replaces this.
3. **A release preflight instead of a reviewer.** At each green head, `sh-release-preflight`
   checks that every changed file is one `changeset version` writes, and that every public
   package in the release is already on registry.npmjs.org. A brand-new package cannot use
   trusted publishing until its first version is published by hand, so it blocks with its
   name.
4. **The `shepherd-release` decision.** A passed preflight at the exact head merges under an
   `auto` seat (`shepherd-release/version-packages`). A blocked preflight
   (`preflight-blocked`), a missing one (`no-preflight`) or an `owner-gate` seat
   (`owner-gate`) opens `approve-merge`, and a `never` seat denies.
5. **A merge freeze.** Every main push regenerates the pull request. While its head is ready,
   meaning the preflight passed under an `auto` seat, the repo's other Shepherd merges wait in
   `merging`, then read CI again. The freeze ends when the release merges, its head moves, or
   30 minutes pass.

## `merge` evaluates, and resolves nothing

```sh
titan-factory shepherd merge owner/repo#123
```

```
run ab0f9228-… awaiting-approval: policy says gate (seat none policy owner-gate waits for the owner on merge); owner: resolve approve-merge
```

`merge` reports three things: what the policy decides for the current head, whether the
pull request is held, and what the run waits on. It never signals the run and never
resolves a gate. An agent can call it over MCP to learn why a pull request has not merged.
It cannot use it to merge.

## Resolving a gate is CLI-only

`gate resolve` is not a registry command. No `/rpc` route and no MCP tool can answer a gate
(`products/factory/src/shepherd/surface.test.ts` asserts that no tool name contains
`resolve`). The owner answers at a terminal:

```sh
titan-factory gate resolve <runId> approve-merge --json '{"decision":"merge","headSha":"<40 hex>"}'
```

| Gate | Opens when | Payload |
| --- | --- | --- |
| `approve-merge` | one of the [three reasons](#routing) | `{"decision":"merge"\|"abandon","headSha":"…"}` |
| `ci-failed` | a head is red and no agent took the wake | `{"decision":"rerun"\|"abandon"\|"await-fix","headSha":"…"}` |
| `stuck-behind` | the branch is still behind after three updates | `{"decision":"retry"\|"abandon"}` |
| `sh-sent-back` | a review sent the head back and no agent took the wake | `{"decision":"await-new-head"\|"abandon"}` |
| `main-red` | main CI on the merge commit is unread, or red with no freeze store wired | `{"decision":"acknowledged","mergeSha":"…"}` |
| `main-red-again` | main is red again while the episode already has a fixer | `{"decision":"stay-frozen"\|"unfreeze","mergeSha":"…"}` |
| `main-frozen` | the repo is frozen with no fix task, no fixer, or after a green merge that did not thaw it | `{"decision":"stay-frozen"\|"unfreeze","mergeSha":"…"}` |

`titan-factory resume` and the `factory.gates` command print the exact resolve command for
each open gate. Repeating a resolve with the answer the run already took exits 0 and prints
`already resolved`.

## The MRG-AU-RV row and the merge evidence

Under `auto`, one rule lets Shepherd merge without the owner: `MRG-AU-RV` in the
[`authority`](/reference/authority) table. It allows a merge by automation when all of these
hold at the exact head being merged (`packages/authority/src/table.json`):

- the verdict's author is the reviewer this run dispatched, and the verdict is `MERGE` at
  this head;
- every required check context is green, from GitHub Actions, and no other run on the head
  is non-green;
- GitHub's test merge of this head is clean;
- the repo is not frozen;
- no protected path changed;
- the seat grants `merge-on-green-approve`.

Shepherd adds its own guards before it asks authority
(`products/factory/src/shepherd/merge-facts.ts`). No collected facts, facts collected at
another head, or any changed path under `.github/` sends the merge to the owner. A file list
that GitHub truncated counts as no list. Every fact is read from GitHub or from the run's
own step outputs, never from the reviewer's text. Any other authority rule that allows still
gates: only `MRG-AU-RV` merges without the owner.

The `sh-merge-evidence` step collects those facts once per head and posts one comment on the
pull request. The comment starts with the marker `<!-- shepherd-evidence:<head sha> -->`, so
a replay finds it instead of posting again. It carries a one-line summary and a JSON record:
the run id, repo, pull request, head, base, GitHub's test-merge sha, each check run with its
app id and conclusion, a reference to the reviewer's verdict (session id, record offsets and a hash of the full locator, with no path, host or source id), the reviewer's identity, and
the decision with its rule and reason. On an allow, the same record is stored with the
`merge-policy` step, with the full locator in place of the reference.

To recompute `locatorSha256`, take the stored locator, run `JSON.stringify` on it with its keys
in their original insertion order, and take the SHA-256 hex digest. Only the reader that
produced the locator keeps that key order, so a re-serialized copy may not match.

## What is not built yet

The land core, the hold, the policy resolution, the gates, the post-merge main CI read and
the freeze all run today, and so does the review phase when it is configured. These parts are not built:

- **The review phase is opt-in.** With `shepherd.review` set (see the
  [config file](/guides/factory#the-config-file)), `reviewPhase` in
  `products/factory/src/shepherd/review.ts` dispatches a reviewer through agent-chat in the
  checkout the seat book binds to the repo, and reads its verdict from that agent's
  transcript. A verdict then reaches the `MRG-AU-RV` decision, and the `sh-merge-evidence`
  step posts the evidence comment. With no `review` key, no checkout for the repo, or a
  refused dispatch, the phase records `none` with the reason, and the
  [route table](#routing) sends the head to a fresh reviewer until 3 rounds have failed.
- **The freeze exemption is not a security boundary.** `register` accepts any
  `--implementer` string, and the fixer's name is printed in the gate prompt. The exemption
  stops honest mistakes, not a determined caller.
- **Stall limits.** A run that waits a long time in one phase is not flagged.

## How it fails

| What you see | Why |
| --- | --- |
| `error: registration refused: …` | the repo is on a seat deny list or a charter hard stop |
| `error: invalid seat file <path>: …` or `error: invalid charter <path>: …` | a seat file or the charter does not parse; no registration succeeds until it does |
| `error: Invalid arguments: pr: needs a pr or a branch` | `owner/repo` without `--branch` |
| `error: Invalid arguments: policy: Unrecognized key: "…"` | an unknown `--policy` key |
| `error: owner/repo#123 has head <a>, not <b>` | `--branch` is not the pull request's head |
| `error: owner/repo#123 is not registered with shepherd` | `hold`, `release`, `merge` or `timeline` on an unknown pull request |
| `error: expected owner/repo#N, got …`, exit 2 | a malformed reference |
| `error: gh api … failed …` | `gh` cannot reach GitHub; a verb that looks a pull request up needs it |
| a row with `[stalled: …]` | the run failed or is parked as `recovery_required`; `titan-factory resume` reports it |
