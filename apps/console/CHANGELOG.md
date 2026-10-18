# titan-console

## 0.4.3

### Patch Changes

- 336eeb1: Add the `config.report` deposit and the `config.hosts` read. Another host's `titan config report` is taken only over a bearer from another machine, stored under the state dir and shown, never applied. The report schema is strict, so a report carrying a `revision` is refused. A report older than 25 hours shows as not reported.
- 0c9e8ac: Let `inbox.act` answer an agent's chat_ask. `inbox.prepare` reads back the question, its asker, options and recommendation; `inbox.act` takes the owner's `text`, keeps it in the action record, and posts it to the agent-chat broker's `POST /api/answer` on channel `dashboard` through a new `BrokerAnswerer`. Redirects are never followed, a question answered first elsewhere comes back `closed`, and a broker that is down is `unreachable`.
- 382dcde: The inbox page acts: a gate row shows "Approve merge" and an owner-asked hold row "Release hold". The tap opens a confirm sheet that calls `inbox.prepare` and shows the read-back (effect, repo#PR, title, head, how long ago it was read). Confirm stays disabled until that read-back has loaded, then calls `inbox.act` and shows the outcome in the sheet. Cancel sends nothing. When the console cannot act (actions off, owner writes refused, no action, or a snapshot page), the sheet or row shows the terminal command instead.
- d1c31e6: Let `inbox.act` release a `g10-review` or `g10-adversary` hold through Shepherd's `shepherd.release`, as `owner-remote:titan-console`. The release is offered whether or not a reviewer MERGE is recorded: `inbox.prepare` reads back the verdicts from the PR's timeline, counts the MERGEs at the live head (two from two reviewers for `g10-adversary`), and when they fall short says so and labels the confirm "Release without a MERGE". Shepherd's refusal of a moved head comes back as `moved`, and a replay as `already`.
- 5b3eff1: The inbox confirm sheet reads all three read-back shapes: a gate, a g10 hold and a chat answer. A g10 hold's read-back leads with its confirm label, for example "Release without a MERGE", and only a gate's read-back names its gate. This restores the titan-console typecheck on main.
- ae71217: Add the theater's video catalog. `TITAN_CONSOLE_VIDEO_ROOTS` names the directories to list; `videos.list` returns every mp4 and webm under them by opaque id, with captions and render-notes flags, or one gap line when unset. `GET /media/videos/:id` serves a listed video with byte ranges and `/media/videos/:id/captions` its `.vtt`; each request re-checks that the real path stays inside its root, and anything else answers a fixed 404. The dev server forwards `/media/*` to the daemon.
- Updated dependencies [a67d654]
  - @titan-design/pm@0.4.0

## 0.4.2

### Patch Changes

- c1e9177: Add the `config.surfaces` read for this host's agent-chat `config.json` and profiles, the factory config, the console's `TITAN_CONSOLE_*` environment and each Claude Code account's `settings.json` and `.claude.json`. Only fields the catalog allowlist names carry a value; an undeclared key is listed hidden. Permissions and autoMode show as their rule texts, hooks as the commands they run, and `.claude.json` only as its trusted-folder count and MCP server names. The factory's `digest.push` URL is never named.
- b3de4dd: Add `inbox.prepare` and `inbox.act`, behind `TITAN_CONSOLE_INBOX_ACTIONS=1`. `inbox.prepare` reads back a gate resolve or an owner-asked hold release with a five-minute confirm digest. `inbox.act` is an owner-write: it re-reads the item, refuses a stale digest before posting, writes the action record once and posts its id to the factory's `POST /owner/console-action`. A moved head comes back as `moved` and a replay as `already`.
- Updated dependencies [9b5d49f]
  - @titan-design/daemon@0.8.0
  - @titan-design/react-app@0.1.4
  - @titan-design/rpc-client@0.4.1

## 0.4.1

### Patch Changes

- fee50d9: Add the `inbox.list` read: `approvals.flow` joined to Shepherd's live rows, each item with the one action a tap would take (resolve a gate, release a hold, answer an ask, open a round or its source) or the terminal command and why, blocking items first and newest first. A dead source is a gap line, never an empty inbox. Nothing writes yet.
- 53ecdae: Add the read-only Inbox page at `#/inbox`, a rail entry after Home. It lists `inbox.list`: blocking items first, newest first, each with a source badge, its age, a recommendation chip, an evidence link, and a "Run on terminal" button that shows the command, a copy button and the reason. Planning items start collapsed behind their count, and FYIs are a count only. A dead source shows as a banner, so the page never says nothing needs you. Home's "Needs you" region shows the inbox's blocking count and its newest three blockers, each linking to the inbox.

## 0.4.0

### Minor Changes

- 35a04ca: Relay a submitted Ship or Send back to the factory's approve-merge gate. With `TITAN_CONSOLE_GATE_ANSWERS=1` (default off), a `rounds.submit` that writes a merge-bound round's `feedback.json` reads Shepherd's status row for the PR and, only when its head is the head the round showed, posts the answer to the factory; the result is kept once in the round's `answer.json`. A moved head or a closed gate is recorded without a post, and a factory that is down leaves no file for the start-up sweep to retry.
- bcb6d01: `titan-console rounds withdraw <id> --reason <new-head[:<sha>]|closed|answered-elsewhere> [--json]` marks an unanswered round superseded by writing `withdrawn.json` beside it, once; an answered round is kept. `rounds.list` and `rounds.get` report a `withdrawn` status, `rounds.submit` refuses a withdrawn round before writing anything, and `approvals.flow` lists its questions under `withdrawn` instead of the open queue. The verb is CLI only, never an `/rpc` command.

### Patch Changes

- 73a5c21: Add the `approvals.flow` read command: it merges the factory's `needs.list`, the console's deposit spool and its review rounds through owner-queue `consolidate` into one Flow, with a gap line per unreadable source, fyi notices counted rather than ordered, and hidden after-answer recommendations stripped.
- 2116c07: The round listeners log an answered round whose round.json no longer passes the strict facade ("answer not relayed"), and a test pins that `rounds.submit` refuses a blind-ab round.
- 9f24df9: Add the owner-queue readers for the console's own sources: `readQueueRounds` reads each valid round with its validated `feedback.json`, and `roundQueueItems`/`spoolQueueItems` turn rounds and spool deposits into open or answered owner items, with every unreadable file a gap line.
- d9e343b: Round re-import now checks every destination frame's sha256 and every parent directory before it writes anything, and refuses a tampered frame instead of reporting it imported.
- 01a44da: The Ship view saves the owner's side-question answers: each non-merge question is answerable and all answers go in one `rounds.submit` with the Ship or Send back pick.
- dcf0961: The console reads feedback.json with a strict copy of review-schema 0.3.0's `FeedbackSchema`, so an answer that `rounds.submit` marked `recommendationSeen`, or that carries option notes, stays answered in the approvals queue and imports (TP-3272). Feedback with a blind-ab answer is refused. Owner-queue is given 0.3 feedback with only the keys 0.3 added removed. If that projected feedback still fails 0.1, the round is reported as a gap and its questions are not opened again.
- 81402e1: rounds.get fills its answer from the round's answer.json, read without following symlinks and size-capped.
- 3fafd2e: The signed-out pages now say how to get a sign-in link: who to ask, that a link works once for ten minutes and dies on restart, that a session lasts 30 days, and that a home-screen app keeps its own cookies. `createDaemonAuth` and `remote` take an optional `signInHint` so a product names its own command; the console passes `titan-console login-link`.
- 02d5e3a: `rounds.submit` parses round.json with the same strict review-schema 0.3 facade the lister uses, so it refuses any round the Rounds page calls invalid (an unknown top-level key, for one) with "round.json is not a valid round". The loose round@2 manifest parser is gone from `round2-adapter.ts`.
- 6a39d80: The console reads round.json with a strict copy of review-schema 0.3.0's `RoundSchema` (vendored at 4fcb3827 until the release is on npm, TP-3232). Rounds with `baseImage`, `change`, `decision`, `topics` or `prGroups` now list, open, serve frames and import. A blind-ab round is refused, so no engine reaches the page. A round that only 0.3 reads is a gap in the approvals queue until owner-queue installs 0.3 too.
- ea57802: Add the factory upstream: `TITAN_CONSOLE_FACTORY_PORT` (default 7410) and a loopback client for the factory's `needs.list`, which turns an invalid item into a gap line instead of dropping the list.
- 280bc3b: Document `approvals.flow`, the factory upstream and `TITAN_CONSOLE_FACTORY_PORT` in the console README.
- b6cdcee: Add `importRound`, the core of `titan-console rounds import`: it copies a review-harness round dir into the rounds dir as `<unit>-r<round>/`. `round.json` and `feedback.json` must pass the parsers the console reads them with, `frames/frames.json` must name the sha256 of that `round.json` and its unit and round, and only the files it lists are copied, each checked against its sha256. A symlink anywhere in the source is refused, and a refusal writes nothing. A new round is staged in a dot-named dir and renamed into place, with the rounds dir at 0700 and files at 0600. A re-import of the same bytes adds only what is missing; a changed `round.json` or `frames.json` is refused, and an existing `feedback.json` is never replaced. The frames@1 schema gains optional `unit`, `round` and `manifestSha256`.
- a61b5fc: `rounds.list` returns the rounds dir it reads, and `#/rounds` with no rounds shows an empty state naming that dir and `titan-console rounds import <round-dir>` instead of two empty sections.
- 7da4bee: Add `titan-console rounds import <round-dir> [--json]`. It imports a review round into the rounds dir and prints the round id, the frame count, the feedback outcome (`copied`, `kept` or `none`), the loopback `/#/rounds/<id>` URL and, when `TITAN_CONSOLE_HOST` is set, the LAN URL. With `--json` it prints one JSON line instead: `{id, created, frames, feedback, url, lanUrl}`. A refusal prints its reason to stderr, prints no URL and exits non-zero. The verb is local only; no `/rpc` command imports a round.

  The importer now also copies a CI packet's `packet.json` and `prose.json` beside `round.json` when `frames/frames.json` names them. Each file is opened with O_NOFOLLOW, must be a regular file of at most 1 MiB, must match its sha256 and must be valid JSON. The packet's repo, PR and head must equal every merge-bound Ship question in the round, or the whole import is refused. A frames@1 record may carry an `after` image, which is copied and sha-checked like `base` and `diff`.

- bb450c3: Serve Shepherd's reads (`shepherd.list`, `shepherd.timeline`, `shepherd.waiting`) from titan-factory on loopback, behind the console login; no Shepherd write is proxied (TP-2563 a).
- 0c6aeee: Add a read-only `#/shepherd` view: Shepherd's watch list with phase, stage, next action and held or stalled badges, one PR's timeline, and the waiting gates, owner first (TP-2563 b).
- bf17c73: Document the console as the single owner origin: Shepherd on 7410 and the review rounds are reached only through its login, with no `tailscale serve` path router and never Funnel (TP-2563 c).
- 478bdfc: Add the `rounds.frame` read command: one PNG a review round lists, by frame key and view (head, base or diff), as base64 with its sha256. The key must be an image variant in `round.json` or a record in `frames/frames.json`; no path comes from the client. The read refuses a path outside the round, a symlink at any component, a non-regular file, a non-PNG, a file over 8 MiB and a sha256 that does not match the frames index.
- 395f92d: Show a merge-gate round as a Ship view on `#/rounds/<id>`: each changed image as before, after and diff (NEW when it has no before), light and dark renders side by side, images fetched only as they near the viewport and enlarged on a tap. Ship sends `rounds.submit` bound to the question's head sha; Send back sends the other option with the owner's note as its comment; a sent round shows the factory's outcome, or "Waiting for the factory". `rounds.get` gains `ship`, `manifestSha256` and an optional `answer` whose `choice` (merge or send-back) decides whether a resolved gate reads "Merging at <sha7>" or "Sent back: the implementer gets your note"; the new `rounds.frames` read lists each frame's theme and views; a frames@1 record may name an `after` image; `rounds.submit` answers a Ship round whose variants are the PR's images.
- a867240: Add the `rounds.submit` owner-write command: it writes a round's `feedback.json` in the `feedback@1` shape exactly once (`wx`, mode 0600), bound to the sha256 of the `round.json` the owner was shown and, for a merge-bound Ship, the head sha the question names. It refuses unsafe or unknown round ids, unknown question ids, options a question does not offer and feedback over 64 KiB, and returns the written path and sha256. A second submit answers `already-submitted`.
- c85a73b: `rounds.submit` records each answered question in the console decision log: a decider-readable row in `<state>/answers.jsonl`, and a bullet under `## Queue answers <date>` in `TITAN_CONSOLE_DECISIONS_FILE` for one-way, A/B and policy answers. The submit result gains an optional `log` array.
- 5df2317: Show a design round on `#/rounds/<id>` instead of sending it to the harness: each section's `variantKeys` frames as a labelled strip and its `seeAlso` frames as thumbnails, loaded as they near the viewport, scaled to the screen width and opened full size on a tap. Its questions are answered in the page, text included, and sent with one `rounds.submit`; an after-answer round shows its recommendations once sent. Only keys `frames/frames.json` lists are fetched, and a design round whose frames.json is missing or invalid still shows the harness notice. `rounds.frames` gains `indexed`, for the round and for each frame, and `rounds.submit` now answers a design round that has a valid frames.json.
- 5c2fc1f: The rounds list stacks each round into a card on a phone instead of squeezing four table columns into 390 px; the table is unchanged from `md` up.
- Updated dependencies [0dd6186]
- Updated dependencies [6a0952d]
- Updated dependencies [448bcea]
- Updated dependencies [8c89092]
- Updated dependencies [6281b49]
- Updated dependencies [cfc6614]
- Updated dependencies [d357882]
- Updated dependencies [54b6d69]
- Updated dependencies [65287ec]
- Updated dependencies [3fafd2e]
- Updated dependencies [79754af]
- Updated dependencies [1476172]
- Updated dependencies [102a9df]
- Updated dependencies [be96d75]
- Updated dependencies [8f37474]
- Updated dependencies [82d8c0a]
- Updated dependencies [b0fb3e6]
- Updated dependencies [fe65aaa]
- Updated dependencies [28df3a2]
- Updated dependencies [91ea294]
- Updated dependencies [3e94b0b]
- Updated dependencies [adfec4b]
- Updated dependencies [c2d805b]
- Updated dependencies [a914535]
- Updated dependencies [c278211]
- Updated dependencies [4ffd52a]
- Updated dependencies [ba8f25e]
- Updated dependencies [69f323c]
- Updated dependencies [027f0f2]
- Updated dependencies [4ec603a]
- Updated dependencies [608b103]
- Updated dependencies [8438a4e]
- Updated dependencies [abadd64]
- Updated dependencies [216db04]
- Updated dependencies [8c25894]
- Updated dependencies [e6dafd1]
- Updated dependencies [77e2c4d]
- Updated dependencies [6eab4e8]
- Updated dependencies [1c956dd]
- Updated dependencies [f03dea7]
- Updated dependencies [811e8ac]
- Updated dependencies [55cdd43]
- Updated dependencies [2467880]
- Updated dependencies [c50e702]
  - @titan-design/github@0.11.0
  - @titan-design/daemon@0.7.0
  - @titan-design/owner-queue@0.4.0
  - @titan-design/pm@0.3.0
  - @titan-design/registry@0.5.0
  - @titan-design/session-analytics@0.17.0
  - @titan-design/session-graph@0.17.0
  - @titan-design/session-read@0.15.0
  - @titan-design/rpc-client@0.4.1
  - @titan-design/react-app@0.1.4
  - @titan-design/worktree@0.1.6
  - @titan-design/decider@0.6.5

## 0.3.13

### Patch Changes

- Updated dependencies [61511e7]
  - @titan-design/github@0.10.0

## 0.3.12

### Patch Changes

- Updated dependencies [cd830c1]
  - @titan-design/github@0.9.0

## 0.3.11

### Patch Changes

- b0fd912: Document the phone login-link flow, and that a console sign-in survives a daemon restart: the session cookie is signed with `lan.token`, so only an unspent login link dies with the process.

## 0.3.10

### Patch Changes

- Updated dependencies [de21f12]
- Updated dependencies [cd01cfa]
  - @titan-design/session-analytics@0.16.0

## 0.3.9

### Patch Changes

- Updated dependencies [7b9335c]
  - @titan-design/session-read@0.14.0
  - @titan-design/session-graph@0.16.2
  - @titan-design/session-analytics@0.15.1

## 0.3.8

### Patch Changes

- Updated dependencies [f640f72]
- Updated dependencies [3ecb1c7]
  - @titan-design/session-analytics@0.15.0
  - @titan-design/session-graph@0.16.1
  - @titan-design/session-read@0.13.2

## 0.3.7

### Patch Changes

- Updated dependencies [11df74d]
- Updated dependencies [662f42b]
- Updated dependencies [b924847]
  - @titan-design/session-analytics@0.14.0
  - @titan-design/session-read@0.13.1

## 0.3.6

### Patch Changes

- Updated dependencies [aeedb5d]
  - @titan-design/session-graph@0.16.0
  - @titan-design/session-analytics@0.13.3

## 0.3.5

### Patch Changes

- Updated dependencies [7c73654]
  - @titan-design/session-read@0.13.0
  - @titan-design/session-analytics@0.13.2
  - @titan-design/session-graph@0.15.1

## 0.3.4

### Patch Changes

- Updated dependencies [579886b]
- Updated dependencies [587f2de]
- Updated dependencies [3d3cc58]
  - @titan-design/github@0.8.0
  - @titan-design/session-analytics@0.13.0
  - @titan-design/session-read@0.12.2

## 0.3.3

### Patch Changes

- Updated dependencies [be6e34c]
  - @titan-design/session-analytics@0.12.0

## 0.3.2

### Patch Changes

- ddfebf7: Add the knowledge pages. `work.notes` lists notes and top-level sources across initiatives by their `note:` or `source:` ref, `work.record` reads one by ref and flags a truncated file, and `work.search` returns active-work's search hits by ref; all three are reads, and `note.read` and `search` join the active-work `READS`. `#/knowledge` has a Browse tab with initiative, kind and date filters in the query string and a Search tab keyed on `q`; `#/knowledge/<ref>` renders the record as prose and links to its initiative.

## 0.3.1

### Patch Changes

- 6be73ac: Add the Agents pages. `#/agents` has a Roster tab over `agents.roster` and a Messages tab over `agents.messages`, with the broker's window caption. `#/agents/<name>` shows the agent's card, a Runs tab over `sessions.list` filtered to the agent and a Messages tab of its own messages. Tabs follow `?tab=`. `agents.messages` now lists every agent's messages when called without `agent`.

## 0.3.0

### Minor Changes

- 644a538: Add the `#/rounds` read pages. `rounds.list` and `rounds.get` (class read) serve the review rounds under `TITAN_CONSOLE_ROUNDS_DIR` (default `<state>/rounds`), one `<round-id>/round.json` each, validated with `RoundSchema` from `@titan-design/review-schema`. An invalid manifest, round@1 included, is listed with the schema's reason. While an `after-answer` round is unsent, `rounds.get` strips every question's recommendation. `#/rounds` lists open and sent rounds; `#/rounds/<id>` renders each question with its options and keys 1-9 choosing one, through a reusable `RoundQuestion` component. A round with frames shows "design round: open in the harness". Round ids are plain names, symlinked round directories and files are refused, and `round.json` is read only up to 1 MiB.

### Patch Changes

- d6b7b42: Add the Tasks pages. `#/tasks` lists open tasks from `work.tasks` grouped by derived stage, with stage, initiative, severity and text filters kept in the query string and a caption on each guessed stage. `#/tasks/<id>` shows one task from `work.task` with its pull request state, mentions and linked sessions as links. Both ship on react-ui 0.20.0's `Table` and `Badge` until the console pins a react-ui that exports `TaskTable` stage rows and `TaskStagePill`.

## 0.2.1

### Patch Changes

- 46028ea: Replace the Status view with the Home page at `#/`: upstream health, status counts (open tasks, initiatives, live agents, sessions today), a read-only needs-you list of open queue items, blocked tasks and unreachable upstreams with deep links, and the last 24 hours of activity. A queue row links out to agent-chat's `/ui#queue`; the page issues no write.
- 68011ca: Add the Sessions pages. `#/sessions` lists `sessions.list` in a table (agent, tasks, PR, started, duration, tokens, cost) with an `?agent=` filter, "Load more" on the `before` cursor and an "Indexed to" caption. `#/sessions/<id>` renders `sessions.timeline` as a header of facts, a Conversation tab of collapsible turns and a Files tab whose touched files link to their codewatch node when the server mapped one. Loading, empty, not-found and degraded states are keyed on the degraded reason.
- Updated dependencies [3bf2ac3]
- Updated dependencies [4a42590]
- Updated dependencies [b7c53ee]
- Updated dependencies [9c173c9]
- Updated dependencies [c174b71]
- Updated dependencies [c0701a9]
- Updated dependencies [91eea82]
- Updated dependencies [e4dd79b]
- Updated dependencies [845a0cf]
- Updated dependencies [8030b8e]
- Updated dependencies [5c659a3]
- Updated dependencies [dcf8e04]
  - @titan-design/session-read@0.12.0
  - @titan-design/session-graph@0.15.0
  - @titan-design/session-analytics@0.11.0
  - @titan-design/owner-queue@0.3.0
  - @titan-design/github@0.7.0
  - @titan-design/pm@0.2.0

## 0.2.0

### Minor Changes

- f178712: Read task edges and deliverables through `@titan-design/pm`. `work.tasks` and `work.task` rows carry `parent`, `dep` and `deliverables`, read with pm's `readEdges`, so a task with only edge tags and one with edge fields read the same. The blocked-by-dependency stage rule takes its deps from those edges rather than from `dep:` tags. `work.task` also lists the task's `children` and joins each deliverable id to its record from active-work's `deliverable.list`, with `null` for an unknown id and `deliverablesDegraded` set when the daemon has no such read.

### Patch Changes

- 948d6de: Relay the active-work daemon's and the agent-chat broker's `/events` to the browser through the console's own `/events`. Each upstream event becomes one frame named for its source, carrying only its kind and, for the broker, the row id and the two agent names; bodies, meta, refs, paths and the broker token never reach the browser. A reopened upstream stream sends one `reconnected` frame. Upstream dials back off from 0.5 s to 30 s, resetting only after a stream has stayed up for 10 s, a silent or oversized stream is dropped, and the daemon's stop closes every upstream socket. The shell's `useRelayInvalidation` refetches the open pages' `work.*` and `graph.ego` reads on an active-work frame and their `agents.*` reads on a broker frame, at most once per 300 ms per source.
- 875eee0: LAN mode serves HTTPS only: `TITAN_CONSOLE_HOST` now needs `TITAN_CONSOLE_TLS_CERT` and `TITAN_CONSOLE_TLS_KEY` (for example the files from `tailscale cert`), login links are `https://`, and `docs/lan.md` is rewritten for a tailnet install with the tailnet name in `TITAN_CONSOLE_LAN_NAMES`.
- 1893149: Close the widening and optional-presence gaps in the owner-write guard. With the registry's `run` now a property, a handler whose `run` needs the owner-write context no longer compiles once widened to a console-context `Command`, `AnyCommand`, a factory's return type or an array. `readCommand` and `depositCommand` also refuse, at compile time, a handler whose context has any key the console context lacks, checked in every member of a union context, so one that declares `ownerPresence` optional, or whose context is a union with a member carrying it, is no longer served as a read or a deposit. A cast still compiles; the `ownerWrite` mark stays the runtime backstop, and only `ownerWriteCommand` ever hands a handler the presence proof.
- 718eda8: Harden `inbox.deposit`. Its request body is capped at 128 KB before the daemon buffers it, and a larger one gets 413. Once the spool holds 2000 open deposits across all askers, the next deposit gets 429, so invented asker names no longer get around the 200-per-asker cap. An asker or depositId holding a lone surrogate gets 400, and `Bob` and `bob` file as two deposits.
- 84bd62f: A `/rpc` `Content-Length` that is not a number now gets 413 from the body cap instead of passing it. The daemon README names the remaining loopback residual: the cap bounds one body, not how many are in flight. The console's `inbox.deposit` body cap is now three times the stored 64 KB cap, so a valid deposit whose non-ASCII characters arrive as `\uXXXX` escapes is no longer refused with 413.
- Updated dependencies [948d6de]
- Updated dependencies [875eee0]
- Updated dependencies [9e29d34]
- Updated dependencies [c754254]
- Updated dependencies [948d6de]
- Updated dependencies [1893149]
- Updated dependencies [718eda8]
- Updated dependencies [718eda8]
- Updated dependencies [84bd62f]
  - @titan-design/daemon@0.6.0
  - @titan-design/owner-queue@0.2.0
  - @titan-design/rpc-client@0.4.0
  - @titan-design/registry@0.4.0
  - @titan-design/session-read@0.11.1
  - @titan-design/react-app@0.1.3

## 0.1.2

### Patch Changes

- 66f1a7f: Add the `graph.ego` command. Given a ref and depth 1 or 2, it returns nodes and edges typed by kind from the read-only session graph and active-work's `context.graph` mentions. Edge kinds are `holds`, `mentions`, `shares_tag`, `ran`, `spawned`, `linked`, `worked`, `touched`, `edited_by_human`, and `ran_as`, which is synthesised by agent name from `session_origin`. The answer is capped at 150 nodes, 300 edges and 40 per kind at depth 1. It does not expand initiatives or `branch:*/main` hubs, and it collapses files and branches into counts unless the caller asks for them. A `truncated` record counts what the caps left out. When the session graph is missing, the command returns the `context.graph` mentions alone at depth 1, flagged degraded.
- 0691ff9: Document the console's LAN systemd unit and its install, login, rotate and rollback runbook.
- 60c8ec0: Take the session-graph default from @titan-design/app-paths, so ACTIVE_ROOT and the linux XDG location are honoured
- 93beb09: Add the `sessions.list` and `sessions.timeline` commands. `sessions.list` pages indexed sessions from a read-only session graph with their agent, tasks, linked PRs and priced token usage. `sessions.timeline` builds a session's timeline from its transcript, found through the graph or, for a live session the graph has not indexed yet, under the Claude config roots. Both return a degraded entry when the graph file is absent or not migrated, and the timeline does so when an indexed transcript is gone.
- 5a15bb6: Add the `work.tasks` and `work.task` commands. `work.tasks` lists open tasks across every initiative, each with a derived stage from titan-design's task-stage vocabulary, the rule that produced it, a reason naming the evidence, and a `stageGuessed` flag when no evidence was found. Review comes from an open pull request, in-progress from a live worktree or a branch not merged into the main line, and blocked from open `dep:` tags and dependency clauses, holds, and open slices. Git and GitHub are read once per repository and cached for a minute. `work.task` returns one task with its notes, done_when, mentions, artifacts with PR state and the sessions linked through `session_origin.task_ids`; an unknown id is not found. `work.portfolio` rows now carry each brief's `taskPrefix`.
- 73ffaaa: Harden the agent-chat broker client. It no longer follows a redirect, so the token header stays on the broker's own origin. A body that is not JSON or does not match the schema fails as "agent-chat broker <route> answered an unexpected shape" with exit 70, which is how the active-work client already reports drift. A `ui.token` that group or others can access is refused with exit 78 until it is mode 600.
- 73ca10c: Cut the rail to six (Home, Work, Tasks, Sessions, Agents, Knowledge) and add entity routes: `#/tasks/<id>`, `#/sessions/<id>`, `#/agents/<name>` and `#/knowledge/<ref>` round-trip with their query string kept, and a knowledge ref encodes as one segment. Add `refToRoute` for the seven ref classes, `initiativeForTask` for a task id's prefix, and a page registry in `src/pages/index.ts`.
- d819dd1: Add the `agents.messages` and `agents.queue` read commands. `agents.messages` lists an agent's messages, or a pair's, newest first. It pages them with an id cursor from agent-chat's events.db, opened read-only (`TITAN_CONSOLE_EVENTS_DB`, by default `events.db` under `AGENT_CHAT_HOME`). When that file is absent it falls back to the broker's `/api/history` window and marks the result `partial`. `agents.queue` reads `/api/queue` and lists questions first, with each item's asker and age. The broker's own exit and lifecycle notices are counted, not listed, unless `include_system` is set. Neither command writes to the broker or to events.db. A missing ui token, or an events table without the columns read, exits 69.
- 25f02fd: `sessions.timeline` now returns `touchedFiles`: one entry per distinct touched path, with `{touchPath, ref, repo, path, nodeId, href}`. A path inside a repo maps to its repo-relative posix path, which is the code-graph file id, with any leaked `.worktrees/<name>/` prefix stripped, and links to `<codewatch address>#/node/<encodeURIComponent(id)>`. A path outside any repo keeps null `nodeId` and `href` and renders as plain text. The address comes from `TITAN_CONSOLE_CODEWATCH_URL`, by default `http://127.0.0.1:7433`. The index is not checked, so an id codewatch lacks lands on its not-found page.
- 6fe8c70: Split InitiativeDetailPage's load failure and heading into their own pieces so it passes max-function-lines without a suppression.
- 1d52390: Add LAN mode: `TITAN_CONSOLE_HOST` adds an authenticated listener on one address of this machine, beside the unchanged loopback one. `TITAN_CONSOLE_LAN_NAMES` names the hosts it answers to, and `TITAN_CONSOLE_TOKEN` holds its secret. `titan-console login-link` prints a one-time, ten-minute sign-in link, and `titan-console token rotate` ends every LAN session.
- 37c2689: Give every console command a class: read, deposit or owner-write. An owner-write runs only for the owner's session cookie on the LAN listener, from a peer that is not this machine, and only with `TITAN_CONSOLE_OWNER_WRITES=1`; loopback, a bearer and a same-machine cookie get 403. Its handler receives the session's `issuedAt` as the presence proof. Every existing command is a read.
- 3c5b114: Add `inbox.deposit`, the console's first deposit-class command, and `titan-console inbox file [<json>|-]`. Agents file one owner item into the spool at `TITAN_CONSOLE_INBOX_DIR`. The command refuses system fields with 400, a deposit over 64 KB with 400, and an asker's 201st open deposit with 429. A repeat `depositId` returns the item id it already has.
- 20a2407: Refuse a `TITAN_CONSOLE_LAN_NAMES` entry with a `localhost` label anywhere in it (such as `localhost.localdomain`) or a numeric last label (such as `127.1`), which a browser reads as an IPv4 address.
- 9bb6a48: Make console command classes fail closed. Every command now declares its class where it is defined, the console refuses to start if any command has no class, and a classed command cannot be re-classed (for example, an owner-write wrapped as a read).
- 403afcb: Keep `readCommand` and `depositCommand` from wrapping an owner-write handler. Owner-write handlers carry an `ownerWrite: true` mark. The console refuses a marked handler served as a read or a deposit, both when the helper wraps it and when the registry is built. Passing a handler whose `run` needs the owner-write context directly, under its own type, is also a compile error. Widening it to a console-context `Command` or `AnyCommand` first, or casting it, still compiles because `run` is a bivariant method; the runtime mark is the backstop until the registry makes `run` a property.
- Updated dependencies [cb137e3]
- Updated dependencies [c10cfe0]
- Updated dependencies [f88ac00]
- Updated dependencies [f320219]
- Updated dependencies [490489b]
- Updated dependencies [944ef91]
- Updated dependencies [5facf32]
- Updated dependencies [7f4e467]
- Updated dependencies [501b7c2]
- Updated dependencies [b97a26d]
- Updated dependencies [116dd59]
- Updated dependencies [484fadc]
- Updated dependencies [7313f6b]
- Updated dependencies [e963a49]
- Updated dependencies [fb488c6]
- Updated dependencies [45f05b1]
- Updated dependencies [f88ac00]
- Updated dependencies [ae161ab]
- Updated dependencies [ce6cfdc]
- Updated dependencies [a8f0d75]
- Updated dependencies [00c9a6f]
- Updated dependencies [bf95d64]
- Updated dependencies [d31b4fe]
- Updated dependencies [e4700f5]
- Updated dependencies [5b59475]
- Updated dependencies [a5cfd4c]
- Updated dependencies [f34ae27]
- Updated dependencies [f34ae27]
- Updated dependencies [495e6f8]
- Updated dependencies [74f9f51]
- Updated dependencies [a8faac4]
- Updated dependencies [1aed39d]
- Updated dependencies [1fd9652]
- Updated dependencies [deb35d0]
- Updated dependencies [295acf8]
- Updated dependencies [1f7de27]
- Updated dependencies [73ffaaa]
- Updated dependencies [388d791]
- Updated dependencies [59ba612]
- Updated dependencies [d4db9bc]
- Updated dependencies [1cb05e7]
- Updated dependencies [ff6ff86]
- Updated dependencies [ff6ff86]
- Updated dependencies [f8b7be1]
- Updated dependencies [bf5cd2a]
- Updated dependencies [4c1c075]
- Updated dependencies [5b53b87]
- Updated dependencies [37c2689]
- Updated dependencies [3c5b114]
- Updated dependencies [c466784]
- Updated dependencies [d4ef157]
- Updated dependencies [d186dfb]
- Updated dependencies [2159a49]
- Updated dependencies [9784293]
- Updated dependencies [d251acb]
  - @titan-design/app-paths@0.1.0
  - @titan-design/session-analytics@0.10.0
  - @titan-design/daemon@0.5.0
  - @titan-design/github@0.6.0
  - @titan-design/owner-queue@0.1.0
  - @titan-design/react-app@0.1.2
  - @titan-design/registry@0.3.3
  - @titan-design/rpc-client@0.3.0
  - @titan-design/session-graph@0.14.0
  - @titan-design/session-read@0.11.0
  - @titan-design/store-sqlite@0.4.0
  - @titan-design/chat-protocol@0.3.0
  - @titan-design/worktree@0.1.5

## 0.1.1

### Patch Changes

- Updated dependencies [a20a6e3]
- Updated dependencies [0e67551]
  - @titan-design/daemon@0.4.0
  - @titan-design/react-app@0.1.1
  - @titan-design/rpc-client@0.2.0

## 0.1.0

### Minor Changes

- bb898b7: Add the Initiatives view: `#/initiatives` shows the active-work portfolio with open-task rollups, note, source and session counts and newest activity, and `#/initiatives/<slug>` shows one initiative's brief, open loops, open tasks, recent sessions, notes and sources. The daemon gains `work.portfolio` and `work.initiative`, which read the active-work daemon over loopback. Personal initiatives are flagged in the console and left out of the exported page.
- d87df0d: Add the console skeleton: a react-ui app shell with hash routes and a nav for every planned view, served by one loopback daemon on port 7500 whose `upstreams.health` command reports whether the active-work daemon, the agent-chat broker and the session graph can be reached.

### Patch Changes

- Updated dependencies [9172151]
- Updated dependencies [b62813c]
- Updated dependencies [3a4d4ed]
  - @titan-design/chat-protocol@0.2.0
  - @titan-design/daemon@0.3.3
  - @titan-design/react-app@0.1.1
  - @titan-design/rpc-client@0.2.0
