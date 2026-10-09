# titan-console

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
