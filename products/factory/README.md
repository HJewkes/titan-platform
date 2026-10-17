# @titan-design/factory

Code-driven software-factory workflows. Private; never published. Bin: `titan-factory`.

Code owns every workflow transition, retry and evidence record here; a model supplies judgment
only where a step is routed to one. The product composes `@titan-design/workflow`, `hitl`,
`store-sqlite`, `github`, `authority`, `registry`, `daemon`, `session-read` and
`agent-dispatch`. It starts one kind of agent: the Shepherd reviewer, through agent-chat, and
only when `shepherd.review` is configured (see [Shepherd reviewer config](#shepherd-reviewer-config)).
Relay and agent-chat keep every other dispatch.

Usage guides, with every command, where state lives and how each one fails:
[Running the factory](https://hjewkes.github.io/titan-platform/guides/factory) and [Shepherd](https://hjewkes.github.io/titan-platform/guides/shepherd). This README is the design
and file map.

**Run `pnpm build` before any test or live run.** Tests and the bin load sibling packages from
their `dist`, and a stale `dist` behaves like a different release (the `agent` build once
lacked the `claude-print` harness its source had).

Slice S0 (TP-410) added the host, the step router and the two seams. Slices S1 and S2 (TP-411)
added the GitHub port and the land core. Three workflows are registered in `src/workflows.ts`:
`land-pr`, `shepherd-pr` and `measurement-audit`.

## Commands

```sh
titan-factory serve [--port <n>]                              # own the database; /health, /rpc and /mcp on loopback 7410
titan-factory land owner/repo#N [--task <t>]                  # start land-pr on serve, or drive it here when none answers
titan-factory resume                                          # drive every unfinished run, then list open gates
titan-factory gate resolve <runId> <stepId> --json '<payload>'  # answer a gate; its stored schema checks the payload
titan-factory service install [--port <n>] [--mcp]            # write the LaunchAgent plist (systemd unit on Linux), load it, wait for /health
titan-factory service status|check|restart|uninstall               # macOS only, like install
titan-factory service deploy [--expect <sha>]                 # fast-forward the dedicated deploy checkout's main (cloned when absent), rebuild the factory closure, restart drained
titan-factory service plist                                   # print the LaunchAgent plist (systemd unit on Linux) for titan-factory serve
titan-factory shepherd register owner/repo#N --task <t> --implementer <agent>  # or owner/repo --branch <b>
titan-factory shepherd status|list|timeline|hold|release|merge ...  # --json prints the result as JSON
titan-factory shepherd owner-release owner/repo#N --head <sha>  # the owner lifts their owner-asked hold; local only
titan-factory digest run [--since 6h] [--dry-run] [--full]   # write the owner digest for the current slot
titan-factory queue-counts                                    # open owner-queue items per source, split by kind; counts only
titan-factory needs [--json]                                  # everything waiting on the owner, merged across the four sources
titan-factory audit <area> --input <file> --out <file>        # run measurement-audit here up to the owner's review gate
```

`--db <path>` picks the database. Otherwise `TITAN_FACTORY_DB`, then `dbPath` in
`$XDG_CONFIG_HOME/titan-factory/config.json`, then `$XDG_STATE_HOME/titan-factory/factory.sqlite3`.
Owner-specific bindings live in that config file, never in this repo.

### A host whose database is frozen: `remoteFactory`

When the live factory moves to another host, set `remoteFactory` in the old host's config file to
the live factory's URL, for example `"remoteFactory": "http://127.0.0.1:7410"` over a port forward.
It must be an `http` or `https` URL with no user or password, and a key that only looks like it
(`remotefactory`, `remote_factory`) fails the load instead of being ignored. While it is set, stderr
names the remote, says this host's database is frozen, and the verb exits 2:

- `serve`, `resume`, `land`, `gate resolve` (and `gate resolve-batch`, once it lands), and
  `shepherd register|hold|release|owner-release|resync` are refused before they probe `--port` or open anything.
  A serve answering that port on this host may be the frozen one, and nothing yet proves it is the
  remote, so these never go over RPC either.
- Every other verb still reads from a serve that answers, but refuses rather than open the local
  database when none does. `shepherd stats` reads the file read-only and still works.

The refusal ignores `--db` and `TITAN_FACTORY_DB`. With `remoteFactory` unset nothing changes. A
LaunchAgent or systemd unit for `serve` on the frozen host restarts the refused serve forever, so
run `titan-factory service uninstall` there first.

`gate resolve` records who answered: the owner at a terminal (`owner-terminal`, your OS user, channel
`factory-cli`). A shell with `AGENT_CHAT_AGENT_ID` set may be an agent or the owner's `!` command in
an agent-chat session, so there the command asks for owner presence first: the macOS Touch ID or
login password dialog, reading `resolve gate <gate id>: <decision> at <head sha>`. A confirmed dialog
resolves as `owner-terminal` and stores the helper's proof id as `confirmEvent`. A cancelled dialog,
a missing helper or output that is not a UUID resolves as `coordinator`, named by `AGENT_CHAT_NAME`,
which hitl refuses, so the command exits 1 and the gate stays pending. The command exits 2 without a
dialog when the gate id, `decision` or `headSha` has an unexpected shape, so no field can break or
hide a line of the dialog. A repeat of an answered resolve exits 0 before any dialog. A shell with no
agent marker still resolves as `owner-terminal` with no dialog. `CLAUDECODE` does not count, because
the owner's `!` commands in Claude Code set it too. No flag or environment variable supplies a proof
or a helper path.

Some answers skip the dialog and resolve as `coordinator`. Owner decision 2026-10-05 (TP-1720) lets a
coordinator retry a stuck-behind gate. Owner decision 2026-10-07 (TP-1904, "mechanical only") adds three
gate classes, each only on evidence the command reads fresh through the GitHub port at resolve time:

| Gate and answer | Evidence the command reads |
|---|---|
| `approve-merge`: `merge` at the gate's own head | the run's recorded merge decision at that head is `authority/MRG-AU`, and its reason lists only mechanical unmet MRG-AU-RV conditions (`verdict-merge-at-head`, `required-contexts-green`, `no-non-green-run`, `merge-tree-clean`), so a protected path (CODEOWNERS, docs/CODEOWNERS, .github/CODEOWNERS, .gitmodules, a non-canonical path), a missing seat grant, a frozen repo, a tainted request or a reason it cannot read stays the owner's; the seat policy is `auto`, the registration is not held and the repo is not frozen; the reviewer's `sh-await-verdict:<head>` result is MERGE at exactly that head; every required check of the base has a successful run at the head; the PR is open at the head and its `mergeable_state` reads as MERGEABLE |
| `main-red`: `acknowledged`, `main-frozen`: `unfreeze` | the PR merged as the gate's merge sha, and the base branch's tip contains that sha with every judged check passing (the base branch's required contexts when it has them, else every Actions run) |
| `abandon` on `approve-merge`, `stuck-behind`, `sh-sent-back` or `ci-failed` | the PR the gate names is merged or closed; an `approve-merge` abandon also needs the same non-visual merge decision as a merge |

The evidence (verdict step, check run ids, mergeable read, green main sha and merge base, or PR state)
is stored on the gate as `resolvedEvidence`, and the gate store re-checks it against the gate's own
prompt, schema and brief before it admits the coordinator, so an audit can re-run the same check later.
Any read that fails or comes back partial, a pending or red check, an unknown mergeable, a payload or PR
head other than the gate's, or a missing verdict reads no evidence, and the command falls back to the
dialog above. A visual-path, seat owner-gate, route-escalation or release gate, a round
pick, and every other gate still need the owner's presence.

The dialog does not yet stop an agent that only runs the CLI. Only `AGENT_CHAT_AGENT_ID` is read, so
an agent that runs `env -u AGENT_CHAT_AGENT_ID titan-factory gate resolve ...`, or sets the variable
to an empty string, resolves as `owner-terminal` with no dialog. That path stays open until the owner
decides whether every `gate resolve` asks for presence, including a plain terminal.

`pnpm factory:install` compiles the helper into `native/build/owner-presence`, outside `dist`, so a
`pnpm build` leaves it in place. `service deploy` only installs and builds, so it does not compile
the helper: after updating to a release that moved the helper, rerun `pnpm factory:install` or
`node scripts/factory-build-helper.mjs`. Until then the helper is missing, and a resolve from a shell
with `AGENT_CHAT_AGENT_ID`, including your own `!` command, is refused as `coordinator`.

Before each run, `gate resolve` checks the helper path with `lstat`. The helper and every parent
directory up to `/` must be owned by root or by your OS user, with no symlink and no group or other
write bit. The helper itself must be a regular file. If any check fails, presence fails closed, and
stderr names the path component that failed. The search order is fixed in code: if
`/usr/local/libexec/titan-factory/owner-presence` exists, it is the only helper used, even when it
fails the check. Otherwise the helper is `native/build/owner-presence`. Only a missing path
(`ENOENT` or `ENOTDIR`) counts as absent: any other `lstat` error on the root helper path or a parent,
such as `EACCES`, makes presence fail closed, names the error code on stderr, and does not try
`native/build`.

A helper in `native/build` is owned by your OS user, so an agent running as you can still replace it.
To close that, install the helper as root after `pnpm factory:install`, from the checkout root:

```sh
sudo install -d -o root -g wheel -m 755 /usr/local/libexec/titan-factory
sudo install -o root -g wheel -m 755 products/factory/native/build/owner-presence /usr/local/libexec/titan-factory/owner-presence
```

Repeat the second command whenever the helper source changes. If `/usr/local/libexec` belongs to
your user, as it can with an Intel Homebrew install, the check refuses that parent. `dist/bin.js` is
still writable by your OS user, so an agent that rewrites it can skip the dialog.

The helper also holds an owner signing key in the Mac's Secure Enclave, so another host can check a
presence proof. `owner-presence keygen` creates an ECDSA P-256 key whose every use needs Touch ID or
the login password, and writes only CryptoKit's opaque enclave blob, mode 0600, to
`~/Library/Application Support/titan-factory/owner-key.se`. It refuses to overwrite that file
without `--replace`. `owner-presence pubkey` prints the SPKI PEM, and `pubkey --id` prints the key id:
the first 16 hex characters of sha256 over the SPKI DER. `owner-presence sign -- <reason>` reads the
statement bytes on stdin, shows the dialog with the reason, and prints a base64url DER ECDSA P-256
SHA-256 signature that `crypto.verify("sha256", bytes, { key: pem, dsaEncoding: "der" }, sig)`
accepts. `--tag <tag>` picks `<tag>.se` instead, so a probe key never touches the owner key. In code,
`signStatement(bytes, reason)` runs `sign` through the same path checks as `confirmOwner`.

`resume` hydrates every unfinished run, drives each until it completes, fails, parks as
`recovery_required`, or waits on a pending gate, then releases the runs and exits. A run
killed with `kill -9` keeps its lease for 30 s. `resume` inside that window prints the run as
`held ... leased by <runtime> until <time>` and leaves it alone.

## Owner-signed proofs: `applyProof`

`applyProof` in `src/gate-batch.ts` is the server-side core behind owner presence across hosts. It
applies a statement the owner's key signed. `serve` exposes it as `POST /gates/resolve-proof`
(below); the Mac client that signs comes next.

1. `verifyProof` (`src/presence-proof.ts`) checks the ECDSA P-256 signature over the exact statement
   bytes. It then checks the key, the time window, the audience (this factory's hostname) and the
   digest. A statement with more than one item may not name a release or hardware step.
2. A nonce already in `gate_batch` is refused as `replayed-nonce`. The nonce column is UNIQUE, so a
   race refuses too. Replays are deduplicated on the nonce, never on the signature bytes, because a
   re-encoded (high-S) signature still verifies.
3. Every item is checked against its live gate record. The gate must exist. A merge gate must ask
   about the item's PR. In a batch, every gate must be an `approve-merge` gate pinned to one head,
   answered `{"decision":"merge","headSha":<the item's head>}`. Neither a `shepherd-release` merge
   nor a release or hardware gate may ride in a batch; those stay one per proof. Any refusal here
   (`item-refused`, naming the item) records and resolves nothing.
4. The proof is recorded in one transaction before anything fires (tables `gate_batch` and
   `gate_batch_item`, migration 15). The record keeps the key id, nonce, digest, the exact statement
   text, the base64url signature, `aud`, `iat` and `exp`, with every item marked `signed`. Anyone can
   re-verify the record offline with the public key.
5. The items then fire in order. Just before an item fires, three checks run. Its gate must still be
   pending, the run must still wait on that exact gate, and a merge gate must still ask about the
   item's head. With a GitHub port, a merge gate's PR must also be open at that head. An item that
   fails is skipped and named: `skipped-closed`, `skipped-moved`, or `skipped-unreadable` when the PR
   read fails.
6. Every other item is signalled with the resolver `{class: "owner-terminal", id: "key:<keyId>",
   channel: "factory-proof", confirmEvent: "proof:<batchId>"}`. The gate store still checks the
   payload against the gate's schema. An item is marked `firing` before its resolve, then `resolved`
   or `failed`. The first failure stops the batch, and later items stay `signed`, so a process that
   dies mid-batch leaves the item it died on marked `firing`.

A one-item proof is the single-gate case. It may answer any gate, including a release, hardware or
main-red gate, with the payload the owner signed.

### `POST /gates/resolve-proof` and the owner key directory

`src/resolve-proof.ts` mounts the route on `serve` through the daemon's `mountRoutes`. It is in
no registry, so it is never an MCP tool or RPC command, and it runs behind the daemon's Host,
Origin, client-header and JSON guards. The body is `{"statement", "signature"}`, both base64url.

| Answer | When |
| --- | --- |
| 200 `{ok: true, batchId, items}` | the proof applied; each item is `resolved`, `skipped-*` or `failed` |
| 400 | the body is not `{statement, signature}`, or the statement is malformed |
| 403 `refusal` | a `verifyProof` refusal: `bad-signature`, `unknown-key`, `expired`, `wrong-aud`, ... |
| 409 `refusal` | `replayed-nonce`, or `item-refused` naming the item |
| 413 | the body is over 512 KiB; reading stops at the limit, whatever Content-Length says |
| 503 `owner keys not installed` | the key directory was refused; `detail` says why |

`src/owner-keys.ts` loads the keys once at start from `/etc/titan-factory/owner-keys/*.pem`,
a path fixed in code with no environment or config override. Every component from the
directory up to `/`, and every key file, is checked with lstat: owned by uid 0, no group or
other write bit, no symlink. Any failed check, or any key that is not ECDSA P-256, refuses the
whole set. Because the directory is root-only, no file can be swapped between its check and
its read. `/health` reports `ownerKeys: {count, ids}` or `{count: 0, refusal}`, and
`factory.gates` returns `aud`, this host's name, for the signer to bind. Rotating a key means
installing the new `.pem`, removing the old one, then `titan-factory service restart`.

## Shepherd commands

`shepherd.register`, `status`, `list`, `timeline`, `hold`, `release` and `merge` are registry
commands. `titan-factory serve` exposes each as the MCP tool `shepherd__<cmd>` and as
`POST /rpc/shepherd.<cmd>`; the `titan-factory shepherd <cmd>` verb calls the server when one
answers and the database directly otherwise. The tool prefix is empty, so `factory.land` is
`factory__land`.

- `register` resolves the seat policy first, so a repo on a deny list or a charter hard stop
  is refused before anything starts. It is idempotent on `repo#pr` and on the PR's head
  branch: a repeat, or a PR registered after its branch, updates the task, implementer,
  reviewer and policy on the existing registration and returns its run. The run's policy only
  ever narrows toward the stored one.
- Once a run merges, `sh-cleanup` closes the registration's `--task` through active-work's loopback rpc unless
  the registration names a `--slice`. It appends `closed by Shepherd: <owner/repo>#<n> at <merge sha> merged` to the
  task's notes first, skips a task already done (so a replay adds no second note), and records an unreachable
  active-work as a caveat on the step's result instead of failing the run.
- `list` and `timeline` return the `WatchRow` and `PrTimeline` shapes in
  `src/shepherd/view.ts`, which the factory UI reads.
- `hold` and `release` write the registration's hold, which every merge route checks.
  A hold's class is the text of its reason before the first colon (`--reason "g10-review: <detail>; <task>"`);
  `shepherd hold` refuses, with exit 65 and before anything is held, a reason whose class is not one of `serve-down`,
  `stalled`, `no-reviewer`, `run-failed`, `visual-gate2`, `g10-review`, `g10-adversary`, `owner-asked` or `owner-review`, and a reason in one of the
  first four (factory-defect) classes that cites no task ID (`src/shepherd/hold-reason.ts`). Two classes carry the G10 rule:
  - `g10-review` releases itself unless it names a `--reviewer` or has no hold event on record (an unreadable history
    counts as none), since either may be a review the owner assigned. When the run's `sh-await-verdict` at the PR's head, read fresh, is a MERGE from the
    configured opus reviewer (`shepherd.review.profile`; `bd-reviewer`, or a profile named for opus) and the required
    checks are green at that head, the `sh-g10-release:<head>:<n>` step releases the hold and records the verdict
    ref (reviewer, session, locator). A FIX_FIRST, a head that moved, a verdict carried from another head, or a
    profile that is not an opus one keeps the hold.
  - `g10-adversary` never releases itself. Seats use it for authority, merge-policy and security PRs, which also
    need a seat's fail-open reviewer until Shepherd has one (TP-1931); release it with `shepherd release <pr> --head <sha>`.
    Registration holds it only for a sensitive path: a `kind=security` PR with no such path takes `g10-review`
    (`g10-review: security kind, no sensitive path`), and test files are not sensitive paths. The security paths include
    agent-chat's `src/leak-guard/**`, `src/agents/*self-grant*`, `src/cli/verbs/permission-hook.ts` and `src/broker/host-directory.ts`.

  - `owner-review` records that the owner assigned the review to a person; no Shepherd MERGE releases it, only
    `shepherd release`.

  Any other class waits for `shepherd release <pr> --head <sha>`. While a `g10-adversary` hold sits over a
  hold of another class, `release` must name the hold it lifts with `--class <class>`.
  - `owner-asked` is the owner saying "hold" or "discuss". It lives in its own slot on the registration, apart from
    the gating hold, so no other hold replaces it and no other release lifts it: not `sh-g10-release`, not a
    `--reviewer` MERGE (at the head or carried to a tree-equal one), and not `shepherd release`, which refuses
    `--class owner-asked` with exit 65 and a bare release of a PR held by it alone. `shepherd hold` refuses it with
    `--reviewer` (exit 65). Every merge route reads it first and holds whatever MERGE stands. Only the owner's own
    release lifts it: `titan-factory shepherd owner-release <owner/repo#N> --head <sha>`, described below. A PR merged
    outside Shepherd with one in force clears it at cleanup, with the release event `owner hold bypassed: merged
    outside Shepherd`.
- `merge` reports the policy decision for the current head and what the run waits on. It
  never signals the run and never resolves a gate.

Gate resolution is not a registry command, so no MCP or `/rpc` caller can answer a gate. It
stays the local `titan-factory gate resolve`.

`shepherd owner-release <owner/repo#N> --head <sha>` is the owner's release of an `owner-asked` hold, and the only
verb that lifts one. Like `gate resolve`, it is local: it opens this host's database and is not in
`SHEPHERD_COMMAND_MAP`, so no registry, MCP or `/rpc` caller reaches it. Its resolver is `ownerResolver` in
`src/gate-resolve.ts`: a shell agent-chat launched (`AGENT_CHAT_AGENT_ID` set) needs the owner's presence
proof and is refused with exit 77 without one; no coordinator allowance or evidence admits it. Any other shell
is `owner-terminal`. It refuses, writing nothing, a PR not at `--head` and a run with no `owner-asked` hold
(both exit 65), and lifts only the owner slot, so any other hold stays in force. The release event's actor is
`owner-terminal:<user>`, plus `proof <id>` when presence was proved.

### Escalations

Shepherd opens `approve-merge` for the owner for five reasons only, listed in `ESCALATIONS` in
`src/shepherd/route-table.ts`. The gate prompt names the reason.

- `conflict`: a merge conflict survived one fixer attempt. Shepherd finds a conflict in one of
  three ways: update-branch fails with a 422, the head reads `dirty`, or the check that runs
  before a gate finds one. It then wakes the implementer once, with the files that likely
  conflict. The next round reads CI at the fixer's head. If that head is behind, it runs a
  fresh update-branch first. If that head still conflicts, the gate opens and no second fixer
  starts. The fixer already had the conflict and failed to settle it, so a second wake would
  likely fail the same way. The count resets when a head reads green, so a later conflict gets
  its own fixer. This is by design (TP-1753). Allowing a second fixer would change merge policy,
  so it needs its own task.
- `policy-denial`: the seat's authority policy does not allow an automated merge, so only the
  owner can approve this one.
- `failed-rounds`: `MAX_FAILED_ROUNDS` review rounds at one task ended with no verdict, a
  timeout or an unanswered hold. Retrying again would only repeat the stall.
- `fix-first-runaway`: the third FIX_FIRST review at one run (`MAX_FIX_FIRSTS` is 3, for every
  kind of PR). Two fix rounds that did not converge mean point fixes are not working, so
  Shepherd wakes no third fixer. The gate reason routes the task to the planner to redesign or
  split it; coord or the owner acts on that, and Shepherd files no planner task itself
  (TP-2394). It is checked before `no-progress`, so a third FIX_FIRST always names this route.
- `no-progress`: two FIX_FIRST reviews in a row ended with `Closer: no`, meaning the head is no
  closer to MERGE than the last one. A FIX_FIRST with `Closer: yes` or no Closer line, and any
  other round, resets the count. Under the cap of 3 it can only fire at the second FIX_FIRST.
- `repair-budget`: `MAX_REPAIRS` fixer wakes of any kind at one run, counted across heads. This
  caps what one PR can spend on agents before a human looks at it.

### A fixer that exits with no push

A FIX_FIRST or ci-failed wake can end with the woken agent exiting at the same head. A red
whose failing tests sit outside the PR's diff is rerun once first. Otherwise `sh-exit-notice`
sends the repo's seat one agent-chat message per run and head. The message names the PR, the
head, the round, the wake mode and the agent's last report, cut to 600 characters and fenced
as data. The step records why the agent stopped:

- `unread`: the wake reached a live agent, and the agent wrote nothing after it. It finished
  the turn it was already in and exited without reading the message. This is the live-wake
  race.
- `read-no-push`: a resume or successor wake, or a live agent that wrote after the wake. It
  took the wake and pushed nothing.

The run then waits for a new head, with no owner gate open. The seat can resume the agent or
start a successor, push a fix itself, or close the PR. A repeat `shepherd register` does not
wake a live run again.

The owner's `sh-sent-back` gate still opens in these cases: the message fails to send, no
single seat owns the repo, the agent exits a second time at a head the seat was already told
about, or the wake was a conflict or fix-proof wake.

### A fixer that cannot start

A wake never resumes a retired implementer. When agent-chat refuses to resume an ended
implementer, as for one on a model its pool no longer runs, the same wake spawns a successor
instead, under the same spawn load gate. Other failures are not refusals and still reach the
owner. If agent-chat refuses the successor too, a FIX_FIRST or NO_REPRO send-back is held:
`sh-wake-implementer` records the refusal and `held`. A held FIX_FIRST then takes the route of a
fixer that exits with no push: `sh-exit-notice` tells the repo's seat why no fixer started, and
the run waits for a new head with no owner gate open. When that notice is not sent, and for a
held NO_REPRO, `sh-sent-back` opens and names the refusal. While the run waits, the watch row's
next action and the wake's timeline entry name the refusal; the row says the seat was told only when
`sh-exit-notice` recorded a sent notice after that wake. A ci-red or conflict wake records no `held`
and keeps its own route, the `ci-failed` gate or the `not-mergeable` stop. The wake has already spent its one repair, so the `repair-budget` cap
still bounds how many such wakes a run makes. A refused message to a live implementer still
opens `sh-sent-back`, since a successor beside a live agent would race it on the branch.

## Review stats

`titan-factory shepherd stats --reviews [--from <day>] [--to <day>] [--repo <owner/name>] [--json [--rows]]` answers
what each review costs and how long it takes, and what each PR's reviews cost in total. Each call first refreshes
`review-stats.sqlite3`, which sits beside the factory database (`~/.local/state/titan-factory/` by default):

- It reads the ledger read-only, and only finished runs completed since the last refresh plus the unfinished ones.
  A repeat call prices nothing again, so it costs a SQL read.
- A round's cost is the agent-chat retire row of its reviewer's session, read from every `logs/*/dispatch.jsonl` under
  `AUTONOMY_ROOT` (default `$ACTIVE_ROOT/claude-channels/sources/autonomy`, and `ACTIVE_ROOT` defaults to
  active-work's XDG data directory). A round with no retire row is priced once from its transcript, else it stays unpriced.

`--from` and `--to` filter by verdict day in UTC, both inclusive. `--json` prints the v1 shape:
`{ v: 1, at, range, perReview, perPr, rows?, refresh }`.

- `perReview` gives `n`, `unpriced`, and `usd`, `reviewMinutes` and `queueMinutes` as `{p50, p90, mean, total}`, with
  the same cut `byRepo`, `byWeek` (ISO week) and `byModel`, and counts `byVerdict`.
- `perPr` gives `n`, the spread of `usd`, `reviewMinutes` and `rounds` across PRs, and `prs`, one row per PR with
  `rounds`, `usd`, `reviewMinutes` and `queueMinutes` summed over its rounds in range, `registeredToMergeMinutes` and
  `merged`, dearest first.
- `refresh` counts the reviews the refresh added, repriced from retire rows, and the transcripts it read.

Text mode prints the distribution, its cuts and the ten PRs whose reviews cost most.

Dashboards can query the store directly, for example `sqlite3 review-stats.sqlite3 'SELECT * FROM pr_review'`.
Schema v1 (`src/shepherd/review-stats-store.ts`) keeps times as epoch ms and money as list-price USD:

| Object | Columns |
| --- | --- |
| `review` table, one row per finished round, keyed `(run_id, round)` | `run_id`, `round`, `repo` (lower case), `pr`, `head_sha`, `reviewer`, `session_id`, `model`, `requested_at`, `started_at`, `verdict_at`, `queue_ms`, `review_ms`, `verdict`, `input`, `cache_read`, `cache_write`, `output`, `usd`, `cost_source` (`retire` or `transcript`, null when unpriced) |
| `review_run` table, one row per shepherd-pr run | `run_id`, `repo`, `pr`, `registered_at`, `merged_at` |
| `pr_review` view, one row per repo and PR over all time | `repo`, `pr`, `rounds`, `usd`, `review_ms`, `queue_ms`, `registered_at`, `merged_at` |

## Owner digest

`titan-factory digest run` writes one markdown digest across every seat in the seat book:
a headline, then Needs you, Merged, Stuck, Seats, Spend and, when a source failed, Gaps. The
file is `<date>-<HH>.md`, named for the latest slot (06, 12 and 18 local by default), in the
digest dir and again in the iCloud dir. A rerun in the same slot replaces it. The window runs
back to the previous slot; `--since` overrides it, `--dry-run` prints instead of writing, and
`--full` lifts the caps (10 asks, 5 merged, 5 stuck) that keep a digest under 400 words.

Its sources:

- Shepherd rows and pending gates, from `titan-factory serve` when one answers, else the database.
- `agent-chat digest --json --prs --since <window>`, with a 20 s timeout.
- Each seat's `queues/<seat>.md` numbered items under `## Morning queue (owner only)`.
- Each seat's `logs/<seat>/dispatch.jsonl`: spawns and estimated dollars.

A source that fails becomes one Gaps line and the rest still render. An ask that names the
same PR or run id as an earlier one is dropped, so a factory gate wins over a queue line
about the same PR.

"Decided for you" follows Needs you whenever agent-chat's ledger holds questions the decider
answered in the window. Each line gives the question, the answer, the class, and, when agent-chat
sends them, the confidence, the principle ids and how to reverse it. A decision still awaiting
audit ends with its overrule, `agent-chat answer <id> "..."`. The section closes with the 7-day
reversal rate per class. Decisions are notices, not asks: at most 5 are shown, and only as many as
fit the 400 words left after the other sections. The rest count in the closing "and N more" line.
An agent-chat too old to send the list leaves the section out.

With `digest.push` set, each written slot is also pushed to an ntfy topic after the files are
written: title `Digest <date> <HH>:00`, the first three headline lines as the message, and the full
markdown attached (`PUT` with a `Filename:` header). If the server refuses the attachment, the push
retries as a `POST` with the markdown truncated to 4 KB. `tokenFile` names a file holding a bearer
token, sent as `Authorization: Bearer <token>`. A push failure is a warning on stderr; the digest
file in the out dir always stays and the run still exits 0. The topic URL is the only credential
on an anonymous topic, so keep it in the owner's config and out of logs.

```json
{
  "digest": {
    "outDir": "<state>/titan-factory/digests",
    "icloudDir": "<home>/Library/Mobile Documents/com~apple~CloudDocs/Digests",
    "timezone": "America/Denver",
    "slots": [6, 12, 18],
    "push": { "url": "<ntfy topic URL>", "tokenFile": "<home>/.config/titan-factory/ntfy-token" }
  }
}
```

Every key is optional. `outDir` defaults to `$XDG_STATE_HOME/titan-factory/digests`, and no
`icloudDir` means no copy, and no `push` means no push. `push.tokenFile` is optional. `queuesDir` and `logsDir` default to `queues` and `logs` beside
`shepherd.seatsDir`. `queuesDir` also sets the directory the `needs` owner-queue reader reads;
unset, that reader uses `<active root>/claude-channels/sources/autonomy/queues`. Paths must be
absolute.

## Owner-queue sources

`src/needs/` holds the factory's `QueueSource` adapters for `@titan-design/owner-queue`. Each
maps one store of record to `OwnerItem`s and owns its own I/O.

- `agentChatSource` reads agent-chat's `GET /api/queue` on loopback. The port comes from
  `broker.meta.json`, and the token from the 0600 `ui.token`, both under `AGENT_CHAT_HOME`
  (default `~/.agent-chat`). The token is only ever sent in the request header. A question
  becomes a two-way Decide item. A permission prompt or an endorsement becomes a one-way
  Approve item. A notice or message is a Know item, unless its item shape names an ask.
  `resolve` posts `/api/answer` (or `/api/dismiss` for a blank answer) on the `factory`
  channel, and the broker arbitrates.
- `hitlGateSource` lists the factory's own pending hitl gates as one-way Approve items keyed
  `gate:<id>` and `run:<runId>`. Its `resolve` refuses. Gates are answered with `gate
  resolve`, because that verb checks owner presence.

A broker that is not running, is unreachable, refuses the token or returns a malformed body
throws a `QueueReadError` that names the failure. It is never read as an empty list. Neither
store has an event stream that the adapters can use, so `tail` polls `open()` every 30 s and
emits the difference.

`titan-factory queue-counts` prints each source's open count, split by kind. It prints no item
text. It exits 69 when a source cannot be read and still prints the others.

`titan-factory needs` prints the owner's one list. It reads agent-chat, the factory gates, the
Morning queue files and the open `needs-decision` tasks, drops personal initiatives, and folds
items that share an exact key (`gate:<id>`, `run:<id>`, `task:<ID>`, or `pr:<owner>/<repo>#<n>@<full sha>`)
into one. The first line counts what each source read (`36 gates, 88 Morning items, 145 tasks,
19 broker items (approve 3, decide 2, know 14)`). An overlap report follows, naming each subject
two sources share and whether merging folded it; a merged item lists what it was merged from.
`--json` prints the merged `OwnerItem[]` instead. A source that cannot be read prints a line on
stderr and the command exits 69 after printing the rest.

`titan-factory digest run` reads its "Needs you" section from this same list, minus `know`
items, which are news and not asks.

## Measurement audit

`measurement-audit` (`src/audit/`) audits what one system records and what it should. Its input is the
`inputs` block of `titan.measurement-audit/v1` (system, code roots, stores, surfaces, owner, mode), as YAML or JSON.
Its output is the `titan.measurement-audit/v1` report from `@titan-design/health/metrics`.

The eleven steps follow the manifest in `src/audit/manifest.ts`. Each step is code, agent, or both, and each agent
step names its model. The code steps open every store read-only and run only the commands of declared surfaces.
Agent steps run `claude -p` once each through `@titan-design/agent`, with the inventory passed as data. A claimed
Y metric whose baseline query fails or returns nothing is reported as P, and the failure is recorded as an error,
never as a zero. The run stops at the `audit-review` gate for the area owner. After `gate resolve` with
`{"decision":"publish"}`, `titan-factory resume` writes the report to `--out`. Only `mode: initial` runs for now;
a reaudit needs the drift check. Tests inject `AuditPorts`, so no test calls a model.

## Install as a LaunchAgent

```sh
pnpm factory:install                  # pnpm install, build factory and its workspace deps, link the bin
titan-factory service install --mcp   # write the plist, load it, wait for /health, register the MCP endpoint
```

`pnpm factory:install` links `~/.local/bin/titan-factory` to `products/factory/dist/bin.js` in
this checkout (`scripts/factory-link-bin.mjs`). The link is a path, so a rebuild needs no
relink, and it needs neither sudo nor `pnpm setup`. A link that already points at another
checkout is left alone unless you pass `--force`; `--bin-dir <dir>` picks another directory. The
script says so when the directory is not on `PATH`.

The launchd label is `dev.hjewkes.titan-factory` unless the config sets `service.labelPrefix`
(`{ "service": { "labelPrefix": "dev.ex." } }` gives `dev.ex.titan-factory`). The plist file
and every `launchctl` target follow it; the systemd unit name does not. Run `service uninstall`
before changing the prefix, or the old job stays loaded under its old label. When the config
fails to load, every service verb but `service plist` exits non-zero with the config error
rather than act on the default label; `service plist` prints the default label with a warning.

`service install [--port <n>] [--node <path>] [--mcp] [--dry-run]` does these in order on macOS:

1. Boots out `dev.hjewkes.titan-factory` when launchd already holds it, and waits until the
   label is gone.
2. Creates the log directory and writes `~/Library/LaunchAgents/dev.hjewkes.titan-factory.plist`,
   with the `PATH` described below.
3. Runs `launchctl bootstrap gui/<uid> <plist>`.
4. Polls `/health`. The answer must come from the pid launchd reports for the job, so
   a `titan-factory serve` left running in a shell fails the install instead of passing for it.
   On a timeout the verb prints the path of `serve.err.log` and a `tail -n 20` command for it,
   never the log's lines, since a post-merge chore stores this output, and exits 1. The wait
   is 30 s and covers serve's first GitHub check: a `github` field other than `ok` exits 1
   with one line that carries the field.
5. With `--mcp`, runs `claude mcp add --transport http --scope user titan-factory http://127.0.0.1:<port>/mcp`.
   A server that is already registered counts as success. With no `claude` on `PATH`, or when
   the command fails, the verb prints the command to run by hand and still exits 0. Each
   registration prints the config file it wrote. With no `--claude-config-dir` it registers the
   caller's profile only. Agents that run under another profile, such as one under
   `~/.claude-profiles/`, need their own registration: pass `--claude-config-dir <dir>` once per
   profile (it sets `CLAUDE_CONFIG_DIR` for that `claude mcp add`). A path that is not a directory
   fails the install before anything is written.

The plist points at the `dist/bin.js` of the checkout the verb ran from, so install from the
checkout that should serve, not from a worktree that will be removed.

| Verb | What it does | Exit 0 when |
| --- | --- | --- |
| `service status [--port <n>]` | Prints loaded or not, the pid, and a `/health` summary | `/health` answers and its `github` field is `ok` |
| `service check [--port <n>] [--json]` | Read-only diagnosis: one line naming the first cause that holds (`unreadable` (on Linux, `systemctl --user show` itself failed; the line carries its stderr, `detail` its `exitCode` and `stderr`), `not loaded`, `stale pid` (the pid is dead, a foreign pid answers the port, or there is no process), `crash loop`, `unresponsive` (the pid is alive but every `/health` probe timed out; `detail.probeLatenciesMs` lists each), `stale build`, `GitHub down`, `stale index.lock` (the service checkout's `.git/index.lock` with no process holding it, older than 10 minutes, named by path and age and never removed), `deploy stalled` (`/health`'s deploy block has its alarm up), then `tick failing` or `tick stale` from agent-chat's `$AGENT_CHAT_HOME/burndown-status.json`, default `~/.agent-chat/burndown-status.json`, which an absent file skips; a heartbeat older than 3 x its `intervalSeconds` is stale), then `no hub seat` (the config sets no `shepherd.hubSeat`, so a deploy alarm reaches no seat), then the advisory `stale CLI` (the `titan-factory` on PATH, resolved through symlinks, carries a baked build behind the deploy checkout's HEAD and is not the deploy bin itself; `detail` names `installedCli`, `installedBuild` and `checkoutHead`; it leaves `ok` true and exits 0, because callers stop work on a failing check and a restart does not change the CLI); `--json` adds `cause`, `pid`, `health` and `detail`; it always prints within 20 s (`SERVICE_CHECK_BUDGET_MS`) | `/health` answers from the launchd or systemd pid with `github` `ok`, deploys are not stalled, the burndown tick is not failing or stale, and a hub seat is configured; a `stale CLI` alone still exits 0 |
| `service restart [--port <n>] [--drain-timeout <d>] [--no-drain] [--force]` | Waits until `/health` lists no busy run, clears a foreign `titan-factory serve` off the port, restarts without blocking on the stop and fences a process that outlives it (see [The restart fence](#the-restart-fence)), then the same `/health` wait as install | the new process answers with `github` `ok` |
| `service deploy [--expect <sha>] [--port <n>] [--drain-timeout <d>] [--no-drain] [--force]` | Fast-forwards the service checkout, rebuilds the factory closure when the range touches it, restarts drained, and restores `dist` on failure | the target is deployed, already deployed, or skipped as untouched |
| `service uninstall` | Boots the job out when loaded, then removes the plist | the job is unloaded |
| `service plist [--port <n>] [--node <path>]` | Prints the plist, or the unit on Linux, and touches nothing | always |

Every verb except `plist` needs launchd or systemd and fails with one line on another platform;
`check` needs launchd. A server installed with `--port` needs the same `--port` on `status` and
`restart`.

### On Linux

On Linux the same verbs manage the systemd --user unit `titan-factory.service` (the launchd
label without its `dev.hjewkes.` prefix, the rule `active-work.service` follows). The unit lives
in `$XDG_CONFIG_HOME/systemd/user/`, else `~/.config/systemd/user/`, and mirrors the plist:

| Plist | Unit |
| --- | --- |
| `ProgramArguments` | `ExecStart=`, the same argv, quoted where an argument holds a space |
| `KeepAlive` `SuccessfulExit` false, `ThrottleInterval` 60 | `Type=simple`, `Restart=on-failure`, `RestartSec=5` |
| `ExitTimeOut` default | `TimeoutStopSec=60`, so a hand `systemctl --user restart` of a serve that ignores SIGTERM waits 60 s, not systemd's 90 s |
| `RunAtLoad` | `WantedBy=default.target`, enabled by install |
| `EnvironmentVariables` `PATH` | `Environment=PATH=...`, the same `servicePath` value, since a user manager starts jobs with its own minimal `PATH` |
| `StandardOutPath`, `StandardErrorPath` | `StandardOutput=append:`, `StandardError=append:` on the same log files |
| `ProcessType` `Interactive` | nothing: systemd does not throttle a user unit the way macOS throttles a Background job |

`service install` writes the unit, runs `systemctl --user daemon-reload` and
`systemctl --user enable --now titan-factory.service`, adds `systemctl --user restart` when the
unit was already running, then does the same `/health` wait (the answer must come from the
unit's `MainPID`). `status` reads `systemctl --user show` (`ActiveState`, `SubState`,
`MainPID`). `uninstall` runs `disable --now`, removes the unit and runs `daemon-reload`.
`restart` and `deploy` restart with `systemctl --user restart --no-block` and the restart fence. `service plist` prints the unit.
`service install --dry-run` prints the unit or plist and the `systemctl` or `launchctl` calls
install would make, and changes nothing. For the unit to run without a login session, enable
lingering once: `loginctl enable-linger "$USER"`. `service check` reads `systemctl --user show`
on Linux: `MainPID` (no process unless `ActiveState` is `active`), `NRestarts` in place of
launchd's run count and `ExecMainStatus` in place of its last exit code, with the same causes
and exit codes as on macOS. A missing unit reads as exit 0 with `LoadState=not-found` and is
`not loaded`; a non-zero exit from `systemctl --user show` (no user bus because
`XDG_RUNTIME_DIR` is unset, a permission error, a timeout, no `systemctl`) is `unreadable`,
never `not loaded`, since the unit may well be installed.

### The restart fence

A serve whose event loop is blocked never runs its SIGTERM handler, so a blocking restart used to
outlast the deployer's 30 s command cap and send a good deploy to rollback. `service restart`,
`service deploy` and a deploy's rollback therefore restart in two bounded steps:

1. **A foreign serve on the port.** Before the restart, a listener on the service port that is not
   the unit's or job's own process is fenced only when its command line proves it is
   `<node> .../products/factory/dist/bin.js serve`: SIGTERM, up to 15 s, a start-time re-check (a
   reused pid is left alone), then SIGKILL. It prints
   `fenced pid N (titan-factory serve outside titan-factory.service, held :7410): ...`. Any other
   holder, or a listener whose pid is not visible, is refused by pid and argv, and nothing is
   signalled.
2. **The service's own process.** The restart is queued without waiting for the stop
   (`systemctl --user restart --no-block`, or `launchctl kickstart -k`). The verb then waits
   `STOP_FENCE_MS` (45 s) for a new `MainPID`, or a new launchd pid. If the old one is still
   there, it prints `fenced pid N (<unit> MainPID, alive 45 s after SIGTERM): SIGKILL via systemctl kill`
   (`launchctl kill` on macOS), kills through the service manager, so the unit's cgroup or the
   launchd job decides which process dies, and waits up to 10 s more for the new pid.

The 30 s `/health` wait starts only once the new pid exists, so a slow stop cannot spend it. The
success line names the fenced pid: `restarted titan-factory.service (fenced pid N); /health answers
on port 7410`.

`TimeoutStopSec=60` reaches a host's unit only when the unit file is rewritten. `service deploy`
does not rewrite it, so run `titan-factory service install` once after the release that adds it.
That install restarts serve.

`service restart` drains first. It polls `/health` every 5 s until its `busy` list is
empty, and prints the busy runs once a minute. A run is busy when it is `running` and its
current step is in Shepherd's `review` or `merging` phase (`sh-await-verdict` included), or
its step's route has `onRestart: "park"`. When `--drain-timeout` passes (default `45m`), the
restart goes ahead, because every Shepherd step repeats safely. A park-routed step that is still
busy refuses the restart instead, because the restart would leave its run `recovery_required`;
`--force` restarts anyway. `--no-drain` checks `/health` once and does not wait. A service
that does not answer, or a build from before `busy`, has nothing to drain.

`service deploy [--expect <sha>]` rebuilds and restarts the service from the checkout the bin
was built in, which must be on `main` with no tracked changes. It takes the pid lock
`$XDG_STATE_HOME/titan-factory/deploy.lock`. A lock whose pid is dead is stale; a deployer
takes it over by renaming it, so two deployers cannot both win, and on exit removes the lock
only while it still holds its own pid. It runs `git fetch origin main` and targets `--expect`
or `origin/main`; a target not on `origin/main` is refused. A target the running build
(`/health` `build.sha`) already contains is a no-op. A target behind the checkout's own `main`
is refused with the commit to deploy instead. It then diffs the running build sha to the
target against the factory closure, the workspace packages
`pnpm --filter "@titan-design/factory..."` selects, plus the root build inputs
(`pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, `.npmrc`, root `tsconfig*.json`). An
unknown or dirty build sha counts as touched. When nothing intersects it runs
`git merge --ff-only` and records `skipped`.

A touched range whose `pnpm-lock.yaml` changes the version of a package with a native build
(`better-sqlite3`, the one in the factory closure) is refused before anything changes. The
deployer installs under `@titan-design/worktree`'s `setupEnv` pin, whose `ignore_scripts`
skips that package's compile, and a rollback restores `dist` only, never `node_modules`. The
refusal names the package and its versions and lists the steps to deploy it by hand.

Otherwise it copies every closure package's `dist` to `deploy-backup/<running sha>/`,
fast-forwards, runs `pnpm install --frozen-lockfile` under the `setupEnv` pin, builds the
closure, and restarts drained as `service restart` does. Success means launchd's pid answers
`/health` with `github` `ok`, and then `build.sha` equals the target. The sha read polls
`/health` up to 10 times with a 5 s timeout each, so a slow answer under load is not a
failure; only a wrong sha, or no sha in the whole poll, fails. A failed install or build
restores the snapshot and leaves the old process running, untouched. A failed restart or sha
check restores the snapshot and kickstarts again. Both record `rolled-back`, and that sha is
then held until a newer one arrives.
A failed install or build also writes `deploy-build.log` beside `deploy.json`: the command,
target, time, exit code and the redacted last 200 lines of stderr and stdout. The record's `why`
keeps a 20-line tail and names the log; the file holds only the newest failure.

`deployed`, `skipped` and `rolled-back` go to `deploy.json`, which `/health` shows as
`lastDeploy`. A refusal is printed on stderr and never written, so it cannot clear a hold.
The deployer never runs `git reset`: a rollback reverts `dist` and leaves the checkout at the
target.

`serve` watches those refusals. Every five minutes it re-reads the tail of `redeploy.log`.
It judges the deployer only on what it was asked to land: each `service deploy --expect`
line there is an ask, and Shepherd writes one only after a merge's main CI is green. A
deploy lands exactly the sha it was asked for, so a landing (`deployed`, `skipped` or
`already deployed`) covers an earlier ask only when it names that ask's target or a target
asked at or after it. A burst's deployers that lose `deploy.lock` stay behind until something
newer lands. The running build is a landing too, so a deploy fixed by hand clears the alarm:
it lands its own ask, which covers that ask and every one before it and ends the refusals in
a row. A running build that no ask named lands nothing.
`/health` carries a `deploy` block: the running sha, the asks that have not landed
(`behind`, counting only asks older than 20 minutes) and the age of the oldest one, the
refusals in a row, and the last refusal's reason. The alarm goes up on two refusals in a row,
on more than 3 waiting asks, or on an ask over 60 minutes old. A merge that never asked, such
as one with a red main, raises nothing. A refusal because the checkout already landed a newer
commit from origin/main is a deploy finishing out of order, and does not count. When the last
refusal names `index.lock`, its reason ends with a report on the service checkout's
`.git/index.lock`: its path and age, and whether a process holds it. A lock with no holder that
is older than 10 minutes is reported as stale. `shepherd status` ends with a `deploy:` line.
`shepherd status --json --deploy` prints `{ rows, deploy }`; plain `--json` prints the bare
row array, as before. With `shepherd.hubSeat` and `shepherd.agentChatBin` set, the hub seat
gets an agent-chat message when the alarm goes up, and again every
`shepherd.deployAlarm.renotifyTicks` checks (default 6, so 30 minutes) while it stays up. A
failed message is retried on the next check. Once the alarm has stood for
`shepherd.deployAlarm.escalateAfterMinutes` (default 30), serve files one `do` item for the owner
into the titan console's deposit spool (`$TITAN_CONSOLE_INBOX_DIR`, else
`$TITAN_CONSOLE_STATE/inbox/deposits`, default `~/.local/state/titan-console/inbox/deposits`),
keyed on the running build so a restart files no second one. That item is filed with or without
a hub seat. With no `shepherd.hubSeat`, serve logs a warning at start and `service check` fails
with `no hub seat`.

Shepherd starts the deployer itself. After `sh-main-ci` reads green on a merge into the
factory's own repo (its `package.json` `repository`), step `sh-redeploy:<merge sha>` spawns
`service deploy --expect <merge sha>` detached, so it leads its own session and process group
and outlives the `kickstart -k` it triggers, and appends its output to
`$XDG_STATE_HOME/titan-factory/redeploy.log`. The step returns at once. Other repos, and a red
or unread main, record no step. A replay reuses the recorded step, and a service already
built from the merge sha spawns nothing, so the run resumed after the restart is a no-op.

The plist names `dev.hjewkes.titan-factory`: the absolute node path, the built `dist/bin.js`
and `serve`, `RunAtLoad` true, and logs at
`$XDG_STATE_HOME/titan-factory/serve.{out,err}.log`. `ProcessType` is `Interactive`; a
`Background` job is throttled by macOS. `KeepAlive` restarts serve only after a failed exit
(`SuccessfulExit` false), at most once every 60 seconds (`ThrottleInterval`). A serve started
beside a live factory, one whose `/health` pid matches the pid file, logs that and exits 0, so
the job does not loop on it; any other refused start still fails and is restarted.

launchd starts a job with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and serve runs `gh`,
`agent-chat` and `claude` by bare name. So the plist sets `EnvironmentVariables` to one
variable, `PATH`: the directory each of those three is found in when the verb runs, then the
directory of the plist's node (`agent-chat` starts with `#!/usr/bin/env node`), then launchd's
four, each once. Nothing else is copied from the shell. A directory with a `:` in its name is
refused, `--node` included, because it would split into other entries. A binary that is not found is left out
and named in a `warning:` line on stderr; `service install` refuses to run without `gh`. After
moving one of these binaries, re-run `service install`.

The node path is the running node, except that a Homebrew Cellar path (`.../Cellar/node/22.1.0/bin/node`)
becomes the prefix symlink (`<prefix>/bin/node`, or `<prefix>/opt/node@20/bin/node` for a versioned
formula) when that symlink resolves to the same binary, so `brew upgrade` does not break the job.
Pass `--node <absolute path>` to choose another node. After changing node (an upgrade to a different
major, a version manager switch), re-run `service install`.

`/health` reports `github`: `ok` when `gh api rate_limit` succeeds under the job's
environment, else the redacted gh error (a LaunchAgent may not reach gh's keychain token).
`checking` shows until the first probe lands. The probe runs in the background, at most once
a minute, with a 10 s timeout, so a health request never waits on gh.

## Files

| File | Role |
| --- | --- |
| `src/host.ts` | Opens one SQLite file (gates plus runs, the codewatch triage migrations), builds the runtime, registers workflows, implements `resume` |
| `src/definition.ts` | `defineWorkflow`: a workflow declares each step id with one kind (`dispatch`, `seed`, `assisted`). Registration rejects an id with two kinds, and a guarded context fails a run whose code calls an undeclared id or kind. This is the guard for TP-255, where `seed(x)` and `assisted(x)` share a memo key |
| `src/evidence.ts` | **The F3 seam** (see below) |
| `src/gate-policy.ts` | **The F5 seam** (see below) |
| `src/service.ts`, `src/github-health.ts` | The LaunchAgent plist and systemd unit renderers, and the cached `gh api rate_limit` probe behind health's `github` field |
| `src/service-control.ts`, `src/service-ports.ts` | `service install`, `uninstall`, `status` and `restart` over a `ServicePorts` value, and the real ports (`launchctl`, `systemctl`, `claude`, `/health`, the filesystem, the clock). Tests pass fake ports, so none reaches launchd |
| `src/restart-drain.ts` | The busy runs on `/health`, and the drain `service restart` waits on before it kickstarts |
| `src/deploy.ts`, `src/deploy-closure.ts`, `src/deploy-ports.ts` | `service deploy` over a `DeployPorts` value, the closure walk and touched-path filter, and the real ports (git, pnpm under `setupEnv`, `dist` copies, the lock). Tests pass fake ports, so none reaches git, pnpm or launchd |
| `src/config.ts` | zod-validated local config and database path resolution |
| `src/shepherd/seats.ts`, `src/shepherd/policy.ts` | Shepherd seat book (autonomy-seat/v1 files plus charter hard stops) and the per-PR effective policy (see below) |
| `src/cli.ts`, `src/bin.ts` | commander wiring for `resume`, `gate resolve`, `serve`, `land`, `shepherd`, `digest`, `queue-counts`, `needs` and `service` |
| `src/needs/` | The owner-queue `QueueSource` adapters (agent-chat `/api/queue`, factory hitl gates), the merge step over all four, and the `queue-counts` and `needs` verbs |
| `src/digest/` | The owner digest: `collect` (sources to model), `rank` (de-dupe, order, caps), `render-md`, `slots`, and `command` (the `digest run` verb) |
| `src/shepherd/commands.ts`, `src/shepherd/view.ts` | The `shepherd.*` registry commands, and the watch-row and timeline read model they return |
| `src/shepherd/review-stats-store.ts`, `src/shepherd/review-stats.ts`, `src/shepherd/review-stats-report.ts` | The review stats store, its incremental refresh, and the `stats --reviews` report (see Review stats) |
| `src/workflows/land.ts` | The land core (see below) |
| `src/test-support/crash.ts` | Crash harness: host A with a frozen clock hangs in a step and never releases its lease; host B, clocked past that lease, takes the run over |

## Shepherd reviewer config

Two keys under `shepherd` in the config file turn the review phase on. Both are optional.
`agentChatBin` also lets a red main spawn a fixer, and `fixer` tunes that fixer (see
[After the merge](https://hjewkes.github.io/titan-platform/guides/shepherd#after-the-merge)).

```json
{
  "shepherd": {
    "seatsDir": "/srv/autonomy/seats",
    "agentChatBin": "/usr/local/bin/agent-chat",
    "review": { "profile": "rv-readonly", "configDir": "<agent-home>/.claude-profiles/rv", "verdictTimeoutMs": 1800000, "sessionStartTimeoutMs": 300000 },
    "fixer": { "configDir": "<agent-home>/.claude-profiles/fixer" }
  }
}
```

| Key | Meaning |
| --- | --- |
| `shepherd.agentChatBin` | Absolute path of the `agent-chat` executable. Required when `review` or `fixer` is set. Without it a red main spawns no fixer |
| `shepherd.review.profile` | The one agent-chat profile a reviewer is spawned with. The profile is the reviewer's tool grant |
| `shepherd.review.configDir` | Optional. The Claude config directory of the reviewer; absent means agent-chat's default. Must be an absolute path under the agent's home, which agent-chat refuses to spawn outside of |
| `shepherd.review.fallbackConfigDirs` | Optional list. Claude config directories a review moves to, tried in order, while `review.configDir` is out of usage; an account marked exhausted is skipped. Same rules as `review.configDir`. Absent means a review whose account is exhausted holds and alerts only |
| `shepherd.review.verdictTimeoutMs` | Optional, default 30 minutes. How long `sh-await-verdict` waits for the reviewer's verdict before it answers `none` |
| `shepherd.review.sessionStartTimeoutMs` | Optional, default 5 minutes. How long `sh-review` waits for the spawned reviewer's session to show on the roster before it answers `none` |
| `shepherd.review.codewatchRepos` | Optional `owner/name` list. For these repos `sh-review` reads the head's `codewatch-report` CI artifact through `gh` and puts up to 3 of its questions ahead of the others in the brief, and the step records `codewatch: { found, schema, questions }`. A missing artifact, a wrong schema or a failed fetch adds no questions and never blocks the review |
| `shepherd.review.minFreeBytes` | Optional, default 5 GiB. The spawn gate defers a reviewer while the filesystem that holds review checkouts (the app data dir's `checkouts/reviews`) has fewer free bytes |
| `shepherd.review.minFreeInodesPct` | Optional, default 15. The spawn gate defers a reviewer while that filesystem's free inodes are under this percent of its total, or under twice the inodes the last measured checkout took, whichever is more. A filesystem with no fixed inode table has no inode floor |
| `shepherd.review.maxConcurrent` | Optional, default 3. The spawn gate defers a reviewer while this many reviewers run |
| `shepherd.fixer.configDir` | Optional. The Claude config directory of the fixer a red main spawns; absent means agent-chat's default. Same rules as `review.configDir` |

The load fails, with `invalid config <path>: <reason>`, on any of these:

- `agentChatBin` is not an absolute path, `review` is set without `agentChatBin`, or `fixer`
  is set without `agentChatBin` (`fixer needs an agentChatBin`).
- `configDir` is not an absolute path (`~` and relative paths are refused), or `profile` holds a
  slash or `..`.
- `profile` or `configDir` is empty, starts with a dash, or holds whitespace or a NUL byte.
  Each reaches the `agent-chat` argv as one literal argument, so a value that reads as a flag
  is refused.
- `review` or `fixer` holds an unknown key, or a timeout is not a positive integer.

With `review` set, `configuredRoutes` (`src/workflows.ts`) builds one
`agentChatReviewerDispatch` and hands its roster to `transcriptReviewerReader`, so the verdict
is read from the transcript of the agent that was started. The reviewer starts in the checkout
that the seat book binds to the PR's repo: `repos[].path` of the seat that lists the remote. When two
seat files bind the same repo, the later seat file's path wins. A repo with no such path, or
one on a deny list, gets no reviewer, and `sh-review` records
`none` with the reason.

With no `review` key nothing is built: no `agent-chat` process is started, `sh-review`
answers `none`, and the owner gate decides every merge.

### Answering gates from agent-chat: `shepherd.gateNotify`

With `"gateNotify": {}` (and `agentChatBin`) set, serve runs a sweep every 30 seconds
(`src/gate-notify-sweep.ts`) that files each pending decision gate as an `agent-chat ask` under the
label `titan-factory` with task `gate:<gateId>`, and resolves the gate from the owner's answer at
most once. An answer resolves as `owner-remote` (owner decision Q1 of CC-169): any unregistered
caller on the broker's socket can answer, so a gate whose rule does not admit `owner-remote` is
never asked. `label` and `resolverClass` (`owner-remote` or `owner-terminal`) override the
defaults. `/health`'s `gateNotify` block shows `open` asks, `stuck` gates whose ask ended without
resolving them (refused, dismissed, unmappable), `unasked` gates an answer cannot settle, and
`answersError` while the label's answers cannot be read. Each of those still waits on
`titan-factory gate resolve`. Without the key serve asks nothing.

### Answering approve-merge from the console: `shepherd.consoleAnswers`

With `"consoleAnswers": {"roundsDir": "<absolute path>"}` set, serve mounts `POST /gates/answer-ship`
(`src/gate-answer-rpc.ts`); without it the route 404s. The body is
`{runId, gateId, headSha, tree, packetSha, roundId, choice}`, at most 64 KiB, and `choice` is `merge`,
`merge-pick-later` or `send-back`. The route reads `round.json`, `packet.json` and `feedback.json` from
`<roundsDir>/<roundId>` with `O_NOFOLLOW`, refusing a symlinked round dir or file, and runs
`checkAnswer` (`src/gate-answer-check.ts`). The gate it resolves is the request's own: an answer for
a gate the run has moved past never resolves the newer one. It resolves as `owner-remote`, id
`titan-console`, channel `console:ship`, confirm event `packet:<packetSha>`. `merge-pick-later` also
appends one `{at, runId, gateId, headSha, packetSha, roundId, kind: "pick-later"}` line to
`follow-ups.jsonl` (0600) in the state directory, only when this call resolved the gate.

The same key makes each shepherd-pr approve-merge gate offer a third answer, `send-back`, recorded per
gate as step `sh-send-back-offer`. Its payload is `{decision: "send-back", headSha, note}`, and the gate
store refuses it without a note, so gateNotify's bare option and the coordinator allowances can never
give it. The route builds the note from `feedback.json` alone: the round's `general` text, then the
Ship question's `comment`, cut at 4000 characters; a revision with neither is refused. Land then stops
with `sent-back`, and Shepherd wakes the implementer with a `review` wake carrying the note. The run
waits for a new head and never merges the sent-back one; with no agent to wake it opens the seat's
`sh-sent-back` gate. `shepherd waiting` lists no approve-merge gate for it, and the run reads as
`fixing`. A gate opened before the key was set offers no send-back, and the route answers 422 `payload`.

| Answer | When |
| --- | --- |
| 200 `resolved` / `already` | this call resolved the gate, or the same answer already had |
| 400 / 413 | the body is malformed (a round id outside `[A-Za-z0-9_-]{1,64}` included), or over 64 KiB |
| 403 `refused resolver` | the gate store refused the owner-remote resolver |
| 409 `moved` | the gate or GitHub is at another head, or the run waits on a newer gate |
| 410 `gone` | the gate is cancelled or settled otherwise, or the PR is closed or merged |
| 422 `refused` | a binding failed: round files, tree, packet, feedback (a revision with no note included), choice, or a payload the gate does not offer |
| 503 | GitHub could not be read, or serve runs without the shepherd routes |

There is no token, as with `gateNotify`: any process of the same OS user can post. The route is no
registry command and no MCP tool, and the choice comes from the owner's `feedback.json`, not the request.

### Delivering visual packets to the console: `shepherd.visualDelivery`

With `"visualDelivery": {"mode": "shadow"|"on", "console": ["<node>", "<checkout>/apps/console/dist/cli.js"]}`
(and `agentChatBin`) set, serve runs a sweep every 30 seconds (`src/shepherd/visual-delivery-sweep.ts`, `everyMs`
overrides) over each pending approve-merge gate that has a packet dir. A packet is ready once `prose.json` exists
and its packager is off a roster that was read; one not ready `readyTimeoutMs` (45 minutes) after the gate opened
fails `packet-incomplete`. The sweep then checks GitHub's live PR head and the gate, runs
`<titanReviewBin> packet round` and `packet lint --require prose,round --clone <seat checkout> --json`, checks again,
and in `on` runs `<console…> rounds import <packet dir> --json`. Every binary is named in full; nothing is looked up
on PATH. `roundsDir`, when set, reaches the console as `TITAN_CONSOLE_ROUNDS_DIR`; absent, the console's default
applies. Each head's result is written to `<state>/packets/<run>/<head>.delivery.json` (0600, tmp and rename; a
symlink is refused): `shadow`, `imported` (with the round id and URLs), `cancelled` (`new-head:<sha>`, `gate-gone`)
or `failed` (`packet-incomplete`, `no-clone`, `round`, `lint`, `lint-error`, `import`, `import-conflict`). A head with
a result runs nothing again. `/health`'s `visualDelivery` block shows `waiting` gates and `failed` ones. Absent or
`off`, no sweep starts.

In `on`, an `imported` round is carried to `delivered {roundId, url, at}` and one ntfy line goes out: title
`Visual review: <repo>#<pr>`, body `<n> images at <head8>`, `Click` `<origin>/#/rounds/<id>`. The record is written
before the push, so a crash replays to no second push, and a failed push leaves a `pushWarning` in the record and is
never retried. The topic is `visualDelivery.push`, else the top-level `digest.push` (bearer token from its `tokenFile`);
with neither, the round is `delivered` with `pushWarning: "no push config"`. `origins: {lan, tailnet?}` and
`url: "lan"|"tailnet"` (default `lan`; `tailnet` needs `origins.tailnet`) choose the click origin; without `origins`
the click is the LAN URL the import printed. A failed packet, round, lint or import, and `shadow`, push nothing: the
coordinator reads those from `/health`.

Each tick also looks at every `delivered` record whose gate no longer waits. A gate the console's own Ship answer
resolved (channel `console:ship`) is recorded `answered`: no withdraw, no push. Otherwise the sweep runs
`<console…> rounds withdraw <id> --reason <r> --json` with `r` = `closed` (PR closed), `new-head:<sha>` (the live head
moved) or `answered-elsewhere`, and records `withdrawn {reason, outcome}` (`withdrawn`, `already-withdrawn`,
`kept-answered`). It pushes one `Visual review withdrawn: <repo>#<pr>` line (`new head <sha8>` or `PR closed`) only
for `closed` and `new-head` when the outcome is `withdrawn`. A withdraw that fails records `failed` (`withdraw`) with
the stderr line and pushes nothing. ntfy cannot retract a message, so the withdrawn line is a second message.

### A reviewer account out of usage

Only Claude Code's own usage-limit record counts: a final message whose transcript record has the
placeholder model `<synthetic>` and, when it names one, the API error `rate_limit` or
`usage_limit_reached`, with the notice text ("You've hit your weekly limit · resets Oct 10 at 6pm
(America/Denver)"). The same words written by the reviewer itself are read as a malformed verdict,
so a reviewer cannot mark an account. Such a record ends `sh-await-verdict` at once, with no late
read and no correction turn. `sh-account-hold` then:

1. Marks the account (`review.configDir`, or a fallback) exhausted until its reset: the record's
   `quotaLimits.resetsAt`, or else the reset the notice's text names. A reset is believed only if
   it is in the future and at most 8 days out. Any other reset, or none, marks the account for
   1 hour, after which a review tries it again. No mark is ever indefinite.
2. Sends one alert per exhaustion of an account, not per run, to the seat that owns the repo,
   over `agent-chat`. The fact that it was sent is stored in the factory database, so a restart
   does not send it again. An account hit again within an hour of its mark lapsing is the same
   exhaustion and is not alerted again. An alert that fails is tried at the next hold.
3. Moves the review to the first account in `review.fallbackConfigDirs` with headroom, if any.
   Otherwise it holds the run through the store hold `titan-factory shepherd hold` uses, with
   the reason `account-exhausted: <configDir> until <reset>; TP-1955`. The store records the exact
   reason it wrote, and it overwrites or lifts only a hold whose reason still matches that record.
   An owner's hold, whatever its reason says, is never touched. A store it cannot read still holds
   the run, with an unknown reset, for at most the wait's hour.

While the run is held, `sh-account-wait` waits inside the review, so the run never reaches
approve-merge on this reason, and `sh-review-intent` starts no reviewer on an exhausted account.
The wait ends when any account has headroom again (its reset passed); when the owner runs
`titan-factory shepherd release <pr> --head <sha>`, which also clears the account's mark; when the PR's head moves;
or after an hour. Each of these starts a new land round, which reads the PR's current head and
reviews it again. The run's own hold follows the accounts in one place only, where a review picks
its account (`sh-review-intent`, and the failover in `sh-account-hold`): an account with headroom
lifts it, and none places it again, without a new alert. So however the wait ended, a review that
gets an account never leaves a stale hold in front of its MERGE.
The restart drain does not wait on `sh-account-wait`, since a restart only re-reads the store.

### A reviewer dispatch that is refused

A broker that stays busy past its wait started nobody, so the review is retried (`not-started`).
Any other refusal of `sh-review`, such as `ReviewCheckoutUnusable` for a repo that no seat or
`shepherd.repos` entry binds to a checkout, is not counted as a failed round either.
`sh-no-reviewer-hold` holds the run as `no-reviewer: <refusal class> at <head>; TP-2446` and alerts
the repo's seat once. It never replaces another hold. `sh-no-reviewer-wait` then waits inside the
review until the hold is released (`titan-factory shepherd release <pr> --head <sha> --class
no-reviewer`), the head moves, the PR closes, or an hour passes. The head is then reviewed again.
A refusal that still stands finds its own hold and waits again with no second alert. So a repo
with no usable reviewer never reaches approve-merge unreviewed. The restart drain does not wait on
`sh-no-reviewer-wait`.

The same holds for `sh-review-intent`, which reads the roster before choosing a reviewer. A roster
read that times out (`ReviewerAskTimedOut`) is read again every poll for the session-start window,
then the step answers `notStarted` and the review is retried with no round counted. Any other
refusal at the intent holds the run as `no-reviewer` and alerts the seat once. An exhausted account
keeps its own `sh-account-hold`. None of these three counts as a failed review round (TP-2966).

The config file is read when the routes are first built, so restart `serve` after a change to
these keys. The seat book is read again on every spawn.

## Shepherd seat paths

A seat path in `repos[].path` or `deny_repos` is accepted only in one of these shapes:
`~/`, `$HOME/`, `${HOME}/` or `/`, followed by one or more segments of `[A-Za-z0-9._-]`
that are not `.` or `..`. Any other spelling throws `SeatBookInvalid` naming the file, because
an unrecognised spelling could only make a deny miss. Paths compare case-insensitively, with
the home directory unified to `~`.

Symlinks are not resolved: there is no `realpath`, and nothing touches the filesystem. A deny
written through a symlinked directory does not match a repo path written through its target.
Spell both the same way.

## GitHub port

The land core talks to GitHub through `@titan-design/github` (`githubPort` over `ghCliWire`,
and `fakeGitHub` in tests). Its README documents the check-then-act writes and the argument
validation.

## Writing a gate brief

Every owner gate carries a `GateBrief` built in `src/gate-brief.ts`; build one there, never inline.

- `summary` is one line of at most 280 characters. Fixed words are never cut; `summarize` shrinks only the free-text `detail`.
- `evidenceRef` is one line of at most 500 characters: a PR link, a failing check's URL, or a command. `brief()` cuts it with `oneLine`, so a long CI URL cannot make `snapshotBrief` throw.
- Pass free text through `oneLine` before it reaches a field; control characters and line breaks are refused.
- `questions` come from `decisionGate`, which builds the menu and the answer schema from one option list. Mark `recommended` only when the facts support it, and pin the head (`headSha: z.literal(...)`) so an answer cannot cover another head.
- A MERGE carried from another head says so (`carriedFrom`); the summary never claims the reviewer saw the head asked about.

Add the gate to `gate-brief.test.ts`, which runs every brief through `snapshotBrief`.

## Land core: `src/workflows/land.ts`

`land(ctx, { repo, pr }, { policy })` runs these steps, all code, all routed `repeat`:

- `land-rules`: required checks and the strict flag for the PR's base, read at run start. A base that requires no
  status check does not refuse: `ci-wait` then waits on every check-run at the head from the GitHub Actions app and
  lands only when there is at least one and all are complete and green (success, neutral or skipped). The first green read is held until a
  second poll sees the same runs, because a job behind `needs:` has no run yet. Zero runs wait
  and time out; another app's runs neither count nor block. A rules read that errors still fails the run, except one
  answer: HTTP 403 "Upgrade to GitHub Pro" on a repo whose branch endpoint reports `protected: false` reads as no rules,
  so the same all-check-runs rule applies. A `protected: true`, an unreadable branch or any other 403 refuses.
- `ci-wait:<n>`: one blocking step that polls every 30 s (45 min timeout) until every required
  check's latest run completed (every Actions run, for a base that requires none). An empty rollup is pending. `mergeable_state` `unknown` or
  `blocked` keeps it waiting; it is never treated as clean.
- `update-branch:<n>`: only when the PR is behind, under `expected_head_sha`. After
  `MAX_UPDATE_CYCLES` (3) updates the run opens gate `stuck-behind` (retry or abandon).
- `merge-policy:<n>`: before any merge of an untrusted head, `GatePolicy.decide("merge", { headSha })`
  runs and this step records `{ outcome, headSha, rule, reason }`. The workflow branches on the
  recorded decision, so a replay after a crash reuses it even if the policy has changed since.
  `deny` stops the run. `allow` trusts that one head with no hitl gate and stores the caller's
  `allowEvidence`; an update never extends an allow, so each new head gets a fresh decision.
- `approve-merge` (gate): opens when the recorded decision is `gate`. The payload must name the
  head shown (`{ decision, headSha }`), and the gate's stored schema refuses any other head.
- `merge:<n>`: `sha` is the allowed or approved head, or, after a human approval only, a head
  this run's own update built on it (GitHub's merge of that head and the base). A head anyone
  else pushed asks again.

A failed code step stores its error through `redactForEvidence` (`src/redact.ts`). That call
replaces gh token shapes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) and
`Authorization:` header values with a marker, and caps the text at 500 characters.

`land` returns `merged`, `ci-failed` (with the failing checks and their Actions run ids, for
pilot 2 to classify) or `stopped`. Each code step's output is one evidence record whose
`result` the workflow reads. A workflow that lands a PR spreads `LAND_STEPS` into its own step
declaration and `landRoutes({ port })` into the host's routes.

### Not covered

GitHub applies `update-branch` asynchronously, and the fake applies it at once. A kill inside
`waitForHeadChange` can therefore send a second `update-branch` with the same
`expected_head_sha` on resume. The worst case is one extra merge-of-base commit on the PR branch.
That commit cannot reach `merge` without a trusted head: it is trusted only if its first parent
is a head the approval already covers, and anything else asks the human again.

## F3 seam: `traceRef()` in `src/evidence.ts`

`traceRef({ runId, stepId, iteration, attempt })` returns `{ traceId, spanId }`. The trace id is
the run id. The span id is `workflowStepRequestKey(...)`, the attempt grammar of the F3 trace
schema: `workflow:<runId>:<stepId>:<iteration>:<attempt>`. The routed runner passes the attempt to
each route, so a step builds its own span. `evidenceRecord(kind, step, at, body)` stamps
`v`, `kind`, `at`, `traceId` and `spanId` onto a body; the body cannot override them.

F3 projects artifacts and policy decisions from `StepResult.data` under the keys in
`TRACE_DATA_KEYS` (`titan.trace.artifacts`, `titan.trace.gates`). This product does not import
the F3 schema until it is released.

Known gap: only a gate's resolution can put structured values on `StepResult.data` today. A
dispatch result carries `output` text and no `data`. A seed's `data` is `Record<string, string>`
and merges into the run's params. So a code step cannot yet write a `TraceArtifact[]` under
those keys without a workflow change.

## F5 seam: `GatePolicy` in `src/gate-policy.ts`

`GatePolicy.decide(action, target?)` returns `{ outcome, rule: { table, rowId, version }, reason }`.
`gateEverything` sends every action to a human, and `land-pr` uses it. `shepherdGatePolicy`
(`src/shepherd/policy.ts`) decides from the seat policy and, under `auto`, from authority's
MRG-AU-RV row on the merge facts collected at the exact head. `policyTraceGate(decision, ref)` renders a decision as a policy gate entry
with the F3 id `<spanId>#policy:<table>:<rowId>`.
