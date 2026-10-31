# titan-console

## 0.13.0

### Minor Changes

- 2d5013c: Show a collapsed banner line per blocker class above the stale line, with the count, the oldest age and a link to each item's focused inbox card (TP-4544, TP-4388).
- e6671fd: Keep active-work reads in a keyed stale-while-revalidate cache. Concurrent identical `list`, `task.list`, `inventory`, `note.list`, `source.list`, `artifact.list`, `source.read`, `context.graph` and `deliverable.list` reads share one upstream call, an answer under five seconds old is served as is, and one under two minutes old is served while a single refresh runs behind it. An active-work relay frame drops every kept read, and a factory frame drops the factory's. `approvals.flow` now reads the factory through the inbox's cached needs.list, so a slow needs.list no longer times it out.
- 4672c40: An agent page offers Retire for an exited agent that agent-chat spawned (TP-3624). The new `taps.prepare` and `taps.act` pair takes the agent id from the console's roster and the read-back from the factory's `owner-op.preview`. It then posts a plain `retire-agent` op record through the same owner-write guard and factory route as the inbox's retire. A live agent or a seat shows why there is no tap, a snapshot page points at the live console, and no path offers `--force`. The Agents roster gains a "Finished, not retired" filter.
- 38e9dc0: Add the autoresearch run page's backlog and decisions, and widen its header. The backlog lists the newest round's queue after its picks with the pool, bold and follow-up quotas (or the planner's `[EXEMPT]` reason), the rejected adds and each idea's Thompson draw. The decisions group every decided idea by round with its verdict, rung, labelled reason, Δ in pp and σ, runs, spend and ratchet move; a superseded winner reads as requeued. The runs list gains a Round column from the new `round` and `rounds` fields on `autoresearch.runs`, and each round in `autoresearch.run` may carry the planner's `exempt` reasons.
- 7c7a582: Add the autoresearch run page's live lanes: one card per idea in the column of its stage, with each reached stage's time and spend, a running timer from the step's first start, a restart badge and a link to the implementer's session log (or the agent's page while the run names no session). `?idea=<id>` opens a drawer with the idea's stages, facts, agent, evals, ratchet move and its diff on request. A running run is refetched every 15 s until the factory joins the events relay. Each ladder in `autoresearch.run` may carry the implementer's agent and session.
- 2bf0396: Add the autoresearch run page's wins and losses section: a scoreboard (kept, rejected, stopped, superseded, keep rate, $ per kept, wasted $), stops by rung, wins and losses ranked by |Δ/σ|, the planner digest's cell table, and the progress chart. The chart draws every decided idea and a best-so-far step line that only a kept idea moves, with a σ band that stays at the unlocked default until an outcome was judged against the target's lock pair count. It toggles between wall time and ideas evaluated, and a second panel plots cumulative spend. Until react-ui exports `LineChart` with a band (TD-1000), the chart is drawn with `Scatter` in one component. Each outcome in `autoresearch.run` may now carry the G7 `against` noise record (`sigma`, `pairs` and an optional `locked`, which wins over the pair count).
- 89ff2f6: Link a kept idea's ratchet move on the autoresearch run page to its two commits on GitHub, in the decisions table and the idea drawer, when `autoresearch.run`'s target names its repository. `target` may now carry the adapter's `repo` (`owner/name`) and `ratchetPrefix`; without `repo` the move stays plain `from → to` text.
- cf99bc9: Add the autoresearch daemon reader: `autoresearch.runs`, `autoresearch.run` and `autoresearch.diff` proxy titan-factory's read model on loopback, strip fields the page does not pin, and answer an error envelope when the factory is down. The `#/autoresearch` page now loads through them, and the synthetic run lives only in the twin.
- 89ff2f6: Add the autoresearch run page's registries and held-out validator panel. Registries tabs between the last 40 dead ends, the last 40 bugs, and a per-round bug-repeat rate (the share of L0 failures whose reason code an earlier round had already logged). The validator panel is set apart under a report-only notice and collapsed by default. It lists each look's date, ratchet sha, aggregate primary, gates and provenance from an optional `validator` field on `autoresearch.run`, and says "validator not reporting yet" while the run carries none. No other section reads that field.
- 5415dcb: Show each round's planner on `#/autoresearch` (TP-3954). The console's run view accepts C-256 S3e's optional `rounds[].planner { agent, sessionId?, mode?, usage? }`, and each round's group in Decisions opens with a Planner row: the agent, whether it spawned fresh or resumed, and its turn's dollars, cache reads and writes and retries. A round recorded before S3e says "not recorded for this round". The run view also accepts C-256 S4c's optional `stopReason` per run and `lineageDepth` per idea under the engine's names: the Round stat names why an ended run stopped, and the Lineage cell and drawer row show the idea's depth.
- 94267d7: Add the `#/autoresearch` route (rail label "Research"): a runs table and one run's header, read from a synthetic run until the daemon reader lands. The page's read model is `ArRunViewSchema` in `server/autoresearch-view.ts`.
- 4a47da4: Read the C-256 S3a autoresearch fields on `#/autoresearch`. The header's σ names the case it was measured on and follows the engine's own lock and band width. The idea drawer shows the implementer's spawn or resume mode and account, the lane and fork, the noise it was judged against, each L0 check and the implement, eval and micro spend. Dead-end and bug rows link to their idea and show the round (TP-3867). Every new field is optional, so a run recorded before S3a still renders.
- 5fd32b6: The console times each route's first data in the browser and reports it, with per-query timings, to a new `perf.report` deposit command every 10 seconds or when the tab hides. A route row carries its view key and whether it is a detail page, never the id or query. A post holds at most 100 rows, later rows are dropped and counted, and the command accepts only known view keys and registered command names.
- b4e7b9d: Tap a deposit's `close-pr` op from the inbox (TP-3939 S4). `close-pr` joins `CONSOLE_OPS`, so its deposit gets a "Close PR" tap whose read-back says "Close `<repo>#<n>` at `<head>` on GitHub; the branch is kept and reopen is one click". The factory's `pr-closed` answer reads as "PR closed at `<head>`; its branch is kept", lands as a success, and the next state reads the PR closed.
- 7bb7b71: Add the `coord.cards` read: one card per spawning coordinator for a coordinator day, with agents run, agents live now, exit-reported cost, PRs merged through Shepherd and task ids with titles. Spawns come from agent-chat's events.db, since the broker's history window holds about an hour. A merged PR no spawn accounts for, or that two coordinators could own, is listed as unattributed. `coord.shipped` now takes the same calendar-checked `date` argument as the other coordinator reads.
- d35e066: The new `coord.shipped` read lists the day's PRs that Shepherd's finished runs record as merged (TP-1717). It returns the cached theme digest from the state directory's `shipped` folder when one exists, marks it stale when the merged set has changed since, and never calls GitHub or a model.
- 41436d5: Add the `#/coordinator` page: a day picker that writes `?date=`, one seven-day meter per agent-chat account (before today, today, reserve line, glide target, per-day guard, level and stale badges) and one card per spawning coordinator, tagged with its seat when one matches, plus an unattributed group. A cost no agent reported reads `n/a`. Each read fails in its own section, and a missing pace.json or unreadable events.db is explained in words. The cards stack on a phone with 44 px link targets.
- 8efba6c: Tap a deposit's `deploy-pause-clear` op from the inbox (TP-3939 S6). `deploy-pause-clear` joins `CONSOLE_OPS`, so its deposit gets a "Clear deploy pause" tap. The read-back shows the failure pause the factory reads now (when, over which target, why, rollback status) and says "the deploy pacer resumes and may deploy within about a minute", or that a manual hold keeps deploys held. The tap is offered only while the pause is the one the deposit names and no deployer is running. The factory's `pause-cleared` answer lands as a success, a `moved` with `currentPause` reads as a newer pause that is kept, and a `deploying` refusal names the running deployer.
- 2dab7d5: Design round frames take numbered coordinate pins (TP-3773 S4). `a` or a frame's Pin button toggles pin mode and Escape leaves it; a click places a pin and focuses its note, and a press that moves more than 8 px places nothing. On a phone, Pin opens the frame full size and a tap there places the pin. Pins are sent as each frame's `annotations`, measured in frames.json's viewport width (now listed by `rounds.frames` as `viewportWidth`), else the frameReference width, else the PNG's pixels. A sent round draws its pins on the frame, read-only.
- 75f33db: The factory joins the console's `/events` relay as a third source, `factory`: the console dials `127.0.0.1:<factoryPort>/events` with the same backoff, dial timeout, silence limit and frame cap as the others, and passes the browser only each frame's name and run id. A factory frame refetches only `autoresearch.runs` and `autoresearch.run`, coalesced to one refetch per 300 ms window. The autoresearch run page no longer refetches a running run every 15 s.
- 41e36d3: Keep a design round's option picks and frame verdicts in step: picking an option marks its frame Chosen (a pick-one un-chooses the others), choosing a frame picks its option, and an A/B question's side frames take a verdict (TP-3773 S7).
- 1e8e288: Hit-test pins on PNG frames (TP-3773 S5b). A frames@1 record may name an element map as `targets: { file, sha256 }`; the new read `rounds.frameTargets {id, key}` returns its boxes after the same no-symlink, capped (256 KiB), sha256-checked read as a PNG. `rounds.frames` marks such frames `targets: true`, and in pin mode a pin records the smallest box under it as its `target`. A round without `targets` still pins coordinates only.
- b923e39: Show a read-only gate strip on every approval surface: at the PR's live head, the Inbox gate row and each merge-bound round question list CI, reviewer verdicts (MERGEs at an older head shown, not counted), holds with who placed them, and other pending gates. A new `gates.strip` read serves the round page; a failed source read shows as an unknown, unmet row.
- afa9286: `titan-console rounds import` copies a frames@1 record's `targets` element map (`targets: { file, sha256 }` from TP-3773 S5b; TP-3856) beside its PNG. The file goes through the same reader and copy loop as the PNGs: a relative `.json` path inside the round of at most 256 KiB, no symlink at any component, sha256-checked against the record before anything is written and again as it is copied. A record that names no `targets` imports as before. `rounds.frameTargets` now reads through that same reader, with unchanged checks and refusals.
- d666020: Cap a seat at five open owner asks and key a deposit's blocking on its `unblocksNow` line (TP-4353). `inbox.deposit` (and so `titan-console inbox file`) refuses an asker's sixth open deposit with 429, listing the five open ids to merge or withdraw; answered and withdrawn deposits do not count, and the owner (`hjewkes` or `owner`) is never capped. Deposits gain an optional `unblocksNow`: one trimmed line of at most 200 characters saying what the answer unblocks right now. A deposit without it lists under Planning, never Blocking.

  Automation askers named in `TITAN_CONSOLE_CAP_EXEMPT_ASKERS` (a comma list of exact names, `titan-factory` when unset) skip the five-ask cap; their same-key alarms still fold into one item.

- 5895767: Open the inbox on one item from `#/inbox/<item id>`: the row scrolls into view and is marked Linked, Planning opens when it holds the item, and an id no longer open says so. `titan-console inbox link <item-id>` prints that URL on the first LAN name, or loopback when the console has no LAN listener.
- 59059db: Keep the inbox's Blocking section to items whose answer unblocks running work (TP-4352). Each source has one rule: a hitl gate blocks while its live Shepherd run is pending on it at a PR head; a deposit with a gate, merge or hold op blocks while the live run sits at the op's head, a close-pr or retire-agent op never blocks, and any other deposit or agent-chat ask blocks while its asker is live in the broker roster; an open round blocks. Morning lines and active-work tasks move to Planning. A round of several questions is one row, `round:<round id>`, showing its question count.
- d275994: Trim the inbox's Blocking section further (TP-4352). A PR keeps one blocking row, its newest blocking ask, so an item in Planning never demotes a live blocker. An sh-sent-back gate blocks only beside a deposit op on its PR that itself blocks. Personal deposits and agent-chat approvals over a day old move to Planning. A blocking item open past four days carries `aged: true` and is listed under "Older than 4 days" inside Blocking, never hidden.
- 5c0a479: Add the Knowledge Graph tab (TP-1064). `#/knowledge/<ref>?tab=graph` and `#/knowledge?tab=graph&ref=<ref>` draw a react-ui `NetworkGraph` ego, depth 2, from `graph.ego` around a task, note or session; pressing a node opens its record. A cap hit captions "Showing <n> of <m> neighbours.", a mention-only fallback warns that session links are unavailable, and an ego with no neighbours asks for a record.
- 5fbfc6a: Live story frames take pins and pass navigation keys (TP-3960, TP-3793 S5). The story bridge posts the story's named elements as `boxes` after each render, and `iframeSurface` hit-tests them behind the pin seam, so a pin placed on a live frame records the innermost element with a testId. In S4 a frame in pin mode fell back to its PNG; now only a coarse pointer's pin mode does. The bridge forwards only `[`, `]`, Escape and `?` to the page's key map. Enter, Cmd or Ctrl+Enter, digits and letters never leave the story. While a frame has focus it reads "Keys go to the story. Tap outside to answer." The bridge takes `args` from the console page alone and pushes them again after the next render. A frame that fell back to its PNG frees its mount slot, and Enlarge live counts toward the cap (TP-3932).
- cbf3f8a: Show a round's story variants live in the round page (TP-3793 S4). A variant whose `rounds.get` `live.frames` entry has a url renders one iframe per manifest width on the story origin, sandboxed `allow-scripts allow-same-origin allow-forms` with `allow=""`, lazily mounted and fitted to its column. Its captured PNG is the placeholder until the bridge in that frame's own window posts `ready`, and the bridge's `height` sizes it. A story with no `ready` in 10 s, or an `error`, remounts once and then falls back to the PNG with "Live story unavailable" and Retry. At most 4 frames are mounted on a phone and 8 on a desktop. Enlarge live shows the story at 1:1. Ship-bound sections show the PNG first with Open live, and an entry with only a `reason` shows the PNG with that reason. Wired into section strips, question frames and A/B sides; Ship montages stay PNG. A frame in pin mode or holding pins stays its PNG with its pin layer, so pinning works as before.
- 843563c: A Ship round can carry one merge-bound question per PR (TP-3329). Each PR in its `prGroups` gets its own section in the Ship view: the PR's title, kind, task and description, the `changed` lines of its sections, its question frames, its own main-vs-head montages and side questions, and its own Ship or Send back with a Send back note. One "Send answers" press writes every answer to the round's single `feedback.json`, and stays off until each PR has Ship or Send back. `rounds.submit` takes `heads` (question id to head sha) and checks each shipped question against its own head, refusing a missing, wrong or extra head. Ship blockers are worked out per PR, so a comment on one PR's questions or its Send back note never holds another PR's Ship. `round import` takes several merge-bound questions only when each has its own PR group at the same head and is asked in one of that group's sections. Decision 513's Send back note is now per PR, on one rule the page and `rounds.submit` share: each PR sent back needs a comment on its own Ship question or a round note, and a note on another PR's Ship question no longer counts. `rounds.submit` refuses one without, naming the question (`Send back refused for question "<id>": …`), and writes nothing. A sent round's notes carry `picks`, so the page shows which PR shipped. A round with one Ship question behaves as before.
- 9e1d2c2: Tap a deposit's typed owner op from the inbox (TP-3939 S7). A deposit whose `op` is `merge-at-head` gets an `owner-op` tap: `inbox.prepare` reads it back from the factory's `owner-op.preview` (live head, title, base, hold and authority row, with the deposit's words labelled as the asker's proposal), and `inbox.act` writes a record naming the `op` at the previewed head and posts it to the factory's console-action route. A `resolve-gate` or `release-hold` op maps onto the live Shepherd row's own action. While TP-3918 is open, a gate on a replay-diverged run, and every gate with no Shepherd row, is read-only with "resolve from Morning (TP-3918)". After a landed PR tap, `inbox.act` reads the run's live next state (merged, new review or still pending) and the sheet shows it. The factory's `accepted` answer reads as "Merge queued".
- a11e603: Add a perf tab on the config page: route, RPC and upstream timings from `perf.summary` with a 15 min / 24 h toggle and a warning badge on rows over budget; `perf.summary` gains a `routes` section.
- 1803b7d: Record a plan round's approval (TP-4357). A round's `planApprovals` binds a pick-one to a TP-4284 plan-approval entry. The owner's approve pick, from their own `rounds.submit`, writes one `plan-approval` action record with the round id and posts it to the factory's `/owner/console-action`. The start-up sweep only reposts a record that submit wrote, so a relayed or decided answer records nothing. The round page shows each binding's gate, task, repo and scope beside its question, so the owner approves what they were shown; the nudge's one tap and a "rec" reply refuse a bound round, as they refuse a Ship.
- 9411e94: The inbox taps a deposit's `retire-agent` op (TP-3622). The read-back comes from the factory's `owner-op.preview` and shows the agent that holds the name now: its id, state, profile, cwd and who spawned it, plus the RET-OR authority and the proposal. The console offers no tap, and says why, when the name is held by a different agent than the op names, when the agent's session has not exited, when it works on a live Shepherd run, or when the op asks for `force`. The factory's `retired` answer shows as landed with agent-chat's caveats. A `moved` answer carrying `currentAgentId` says the name changed hands.
- dad56ad: `rounds import` and `decisions file` refuse a round that breaks the round builder rules (TP-3769). These are review-schema 0.3.0's `lintRound`, vendored beside the 0.3.0 schema, plus the harness's rule that a Ship is the last question in its section. The refusal names each rule and writes nothing. Rounds already on disk keep opening.
- a797d50: Keep an unsent question or design round's answers across a reload (TP-3778). Picks, text, comments, option notes, frame verdicts, comments and pins, and the round feedback are written to localStorage under the round's id a moment after each change, bound to the round's manifest sha. A reload of the same round and sha restores them; a different sha drops the draft and says "Draft from an older version discarded". A successful send clears it, a sent or withdrawn round never restores one, and a corrupt or schema-failing draft is ignored.
- 89ff834: `rounds.submit` writes `feedback.json` the way the review harness does (TP-1988). Each answer to a recommended question echoes its recommendation, with `agreed` once answered. A pick-one answer echoes the picked option's `after`. A pick of the round's `revisionOption` is written as `revisionRequested`. Every frame is echoed with a null verdict, and answers are kept in round order. Any round, whether question, design or Ship, may be sent with questions unanswered, required ones included, and the file lists them in `unansweredQuestionIds`. Before the file is created, the document is checked against its round, and any problem refuses the submit with nothing written; a revision request with no comment is one. titan-review's `calibration` can now score console rounds. The gate-answer listener reads `feedback.json` with the 0.3 `FeedbackSchema`, and it relays a revision request on a Ship question as a Send back.
- f724a98: `rounds.submit` takes `variants`: the owner's verdict, comment and numbered pins per frame, written into `feedback.json` over each frame's undecided echo. An unknown or repeated frame, or a pin not numbered on its own frame, is refused. A frame comment or pin note counts as free text in the answer notice.
- d97451d: An after-answer round's recommendation can be revealed before answering: `r` or Reveal recommendation fetches it through the new owner-write `rounds.reveal`, which records the reveal in `revealed.json` while `rounds.get` keeps stripping. An answer given while it shows is sent `recommendationSeen: true`, which `rounds.submit` keeps only for a recorded reveal. A shown recommendation now adds the verdict against the owner's pick, its weak point and fallback, and a Recommended badge on its option.
- a862106: Page a round of several sections one section at a time (TP-3781): "Section n of m", Back and Next, a jump list
  that marks each section answered, partly answered or unanswered, `n` and `p` to step, and `?section=<id>` in the
  URL so a reload keeps the page. Focus moves to Next once a section's last open question takes a pick; the send
  card closes the last page. One-section rounds and Ship rounds stay one page.
- bb00f08: A round's page links the previous and next round in its set (same unit, in round order) and the set itself, with `[` and `]` to step; `#/rounds?set=<unit>` lists one set.
- 09c14e9: Withdraw stale review rounds without doing it by hand (TP-3990). A `round.json` may list `supersedes: ["<round-id>", ...]`, a console-owned field lifted off before review-schema's strict parse. Importing or answering that round withdraws each named round that is still open as `superseded-by:<id>`; an answered target is reported `kept-answered`, and an unknown id is reported, never refused. `titan-console rounds sweep [--dry-run|--apply] [--json] [--decisions <path>]` runs that rule over every round and lists the open rounds a decisions file cites as answered or resolved, with the line. A dry run, the default, writes nothing; only `--apply` withdraws, as `answered-elsewhere`. `rounds withdraw` also accepts `superseded-by:<id>`.
- 2c3145c: The served console updates itself. `titan-console self-update`, run every 10 minutes by the shipped `titan-console-update.timer`, fetches origin/main and does nothing unless a commit since the served sha changes the console or a workspace package pnpm says it bundles. Otherwise it builds the new sha in its own release dir, starts it on a spare port and checks `/health` and `/`, swaps the `current` symlink, restarts `titan-console.service` and checks the served build sha. Any failure keeps or puts back the old build, records the outcome, holds that sha until main moves, and files an owner-queue item in the console's inbox spool. The build now stamps `dist/build-info.json`; `/health` carries it as `build`, the new `console.build` read returns it, and the footer shows the short sha and build time.
- b945665: Tap an sh-sent-back gate from the inbox (TP-3939 S8). A sent-back gate joined to a live Shepherd row gets a "Wait for new head" tap whose one decision is `await-new-head`, taken from the gate's own options: `abandon` and `waive-proof` are never offered, and a gate whose options lack `await-new-head` stays on the terminal. The read-back says the run waits for the implementer's next pushed head and nothing merges, and so does the outcome message. The decision log records the decision the tap gave.
- 88a90ba: Show a sent design round's frame feedback read-only: `rounds.get` carries `notes.frames` (each frame sent a verdict, comment or pin), and after a reload each frame shows its verdict as a pill, its comment, and its pins as numbered lines (TP-3773 S3).
- b21b47e: Rounds: a sent round reads back as sent (TP-3767). `rounds.get` returns every sent answer (`notes.answers`: pick, picks, value, text, revisionRequested, optionNotes, recommendationSeen) and the Addressed ticks from `addressed.json` (`notes.addressed`), and an open or sent Ship round carries its earlier feedback. After a reload, question, design and Ship rounds show every question locked with its sent answer marked, A/B option notes read-only, the Ship pick and the Addressed ticks. Round text renders as markdown (TP-3768): the round and section context, each section's Deciding, Changed and Context (now labelled), recommendation rationale through react-ui's `MarkdownProse`, and prompts and options inline. Links open only for http(s), mailto and relative targets; any other target, `javascript:` included, shows its text and links nowhere.
- b04f14c: Ship rounds say, per side question, what would block Ship and send the PR back to the fixer, and badge each answer Blocks Ship or Won't block Ship (TP-3345). Each side answer can be marked This PR or Follow-up: a follow-up never blocks Ship, is recorded in a `follow-ups.json` sidecar, files an owner-inbox `review` item with the answer text and the round and PR, and is not asked to be addressed by a later round of the unit (TP-3346).
- 1aab3e9: Ship rounds take frame feedback (TP-3773 S6b). Each Ship montage takes a verdict and comment, sent as `variants` with Ship or Send back. A frame comment, pin or Rejected verdict turns Ship off as a comment does, and `rounds.submit` refuses such a Ship; Chosen or Maybe alone blocks nothing. A frame comment or pin counts as a Send back note. In a round with several PRs a frame counts only for its own PR. An earlier round's frame feedback appears in `priorFeedback` as `frames` lines and holds Ship until ticked Addressed.
- ffff0ac: Keep an unsent Ship round's answers across a reload (TP-3870). A Ship round now uses the same localStorage draft as question and design rounds, bound to the manifest sha. The draft holds side-question answers and comments, frame feedback, the round feedback, the Addressed ticks, follow-up marks, and each PR's held Ship or Send back with its note. A changed sha drops the draft with "Draft from an older version discarded", a send clears it, and a sent round never restores one. Drafts saved before this change, which have no Ship part, still restore.
- 6fb99d2: Draw a motion's progress stills (`<base>-p<n>` image variants) as one stepper viewer with Prev/Next, a scrubber, a button per progress value and looping flip-book play (TP-3770). The grouping is a key heuristic until titan-design TD-995 declares sequences in the manifest. Verdicts, comments and pins belong to the still shown, under its own variant key.
- ce92e18: Serve review rounds' stored Storybook builds from a story origin of their own (TP-3793 S3). `TITAN_CONSOLE_STORY_PORT` (7501 by default, `0` off) opens a read-only origin on loopback and, in LAN mode, the LAN address behind the same certificate and session cookie. `GET /sb/<buildId>/<path>` serves a build from the store, injecting the story bridge into its `iframe.html`; a build that is not stored gets a fast-fail page whose bridge posts `error`. `GET /__bridge.js` serves the bridge, which posts `ready`, `error` and `height` to the console page only. Every story response carries a CSP that allows `iframe.html`'s inline scripts by hash and is framed only by the console's own origins. `rounds.get`'s `live.origin` now names the story origin for the listener that answered.
- 6da7de7: `titan-console storybooks gc [--dry-run] [--json]` sweeps the Storybook store. It keeps builds that open rounds, or rounds closed in the last 14 days, name. It removes builds that only older closed rounds name. Over 3 GiB, it removes the oldest builds no round names first. It prints each build kept or removed and why, removes nothing when a round's sidecar cannot be read, and never follows a symlink. A multi-PR round can now carry one build per PR group, as a `titan-review/storybook-set@1` sidecar with each build under `storybook/builds/<sha>/`. Each group's variants show only the build at that group's head. Single-build rounds import as before.
- c3a45fa: `rounds import` copies a round's static Storybook build (`storybook/storybook.json`, storybook@1) into a content-addressed store under the state dir, sha256-checking every file and refusing symlinks, unsafe paths, over 5,000 files or over 100 MB. `rounds.get` gains `live`: per story variant, a url on the build, or the reason it shows its PNG (build not at the PR head, unknown story id, unsafe args, missing build). Nothing renders live yet.
- cb2fc02: The Task detail page renders its shell from `work.task` alone, which no longer reads `context.graph` or `artifact.status`. Mentions and branch pull request state come from two new reads the page makes after the shell, each with a loading and an unavailable state: `work.taskMentions { id }` and `work.taskArtifacts { id, slug }`. `work.taskArtifacts` looks up only the task's own branches, with one `gh pr list` per GitHub repository cached for a minute, instead of active-work's one `gh` call per branch in the initiative. `work.task` drops `mentions`, `mentionsDegraded` and `artifacts`.
- c3c6dc8: Page `work.tasks` on a cursor. A read answers at most `limit` rows (default 50, at most 200) in priority order with a `nextCursor` to the rest, in place of the 200-per-stage cap and its `perStage` argument; `counts` still covers every match. The Tasks page shows a skeleton while its first page loads and adds later pages with Load more.
- e93f63c: Add the theater beat editor over a paused still. On a paused explainer render, "Edit this beat" opens the template beat under the playhead as a form generated from its slot JSON Schema (length counters, enum selects, numbers, array rows with add, remove and reorder inside their bounds, new rows with a unique kebab id, read-only ids that cues target), seeks the player to the beat's still, and checks the draft after a pause in typing, showing each problem at its field and the before and after. Save is shown but off, with explainer's reason. Beat starts are ticks on the scrub strip, and `?t=<s>&edit=1` opens the editor on that beat. Two new reads run the installed explainer CLI: `videos.props` (`explainer props --mp4-sha`) and `videos.edit-check` (`explainer edit check -`, a dry run). `TITAN_CONSOLE_EXPLAINER_BIN` names the CLI (default `explainer` on PATH); a missing CLI, a render explainer did not make or a CLI failure is a gap line.
- 580bbaa: Save beat edits from the theater and turn a note into an edit. When explainer reports that renders read edits, the beat editor's "Save and render" sends the whole draft, every beat edited since the last save, as one `videos.edit`: an owner-write that pipes one `explainer.slot-edit/v1` to `explainer edit apply - --start --json`, so one save stores one script and starts one linked run. "Turn into edit" on a comment made on the current render opens the beat under the note's time, and the saved edit cites the note; the note is left as it is. A new read, `videos.edits` (`explainer edit list --mp4-sha`), lists the video's saved edits with their run status under the editor, read again every few seconds while a run is going.
- 648b85b: Give theater comments two kinds, each told to its own seat. The comment box asks whether a comment is about the content or about the video itself, and each `titan-console/video-note@1` comment line gains `about: "content" | "video"`; a line written before reads as content. `videos.note` messages the seat a comment belongs to through the round notices' agent-chat transport: a content comment goes to the video's new optional `owner` sidecar field, else video-coord, and a comment about the video always goes to video-coord. It returns `routedTo: { seat, delivered }`. The player's note list shows each comment's kind and filters by it, the feed counts comments about the video, and those comments no longer count as open for the rendering agent.
- ec0dac6: Draw true-size frames and scale questions on a design round (TP-3772). A variant with a `frameReference` shows its reference ladder over the PNG, each bar its rung's share of the frame's height, with a Fit / 1:1 toggle: 1:1 draws the PNG at the frame's declared CSS width in a box that scrolls. A variant with a `scale` draws its candidates side by side in one full-size frame beside a ladder of sample text, from the PNG captured for each candidate, listed in frames.json under `<variant key>-<arg>-<candidate>` as the harness names its capture; an uncaptured candidate reads "Not captured". Other frames draw as before.
- 720e72e: Design rounds: a fitted true-size or scale frame says "shown at N%" below its declared width and never grows past it, a PNG whose natural size is not the frame's declared size shows a warning, and scale frames take pins (TP-3874).
- 95a36c4: Offer "Waive fix-proof" on a waivable sh-sent-back gate (TP-3626). Where the gate's own options list `waive-proof` (a NO_REPRO send-back, or a fixer's exit from a fix-proof wake), the item keeps its "Wait for new head" tap and gains a second, outline-styled one. `inbox.prepare` and `inbox.act` take an optional `decision` to pick it; the read-back says the fix-proof is skipped for the shown head only, that the tap merges nothing, and that the merge still needs the owner's Approve merge tap. A gate whose options do not list `waive-proof` is never offered it, and the posted record names the one decision given.
- e6671fd: `work.tasks` answers warm in tens of milliseconds and sends about 127 KB instead of 1.6 MB. An active-work change frame now
  marks the cached active-work answers stale instead of dropping them. They are still served while one refresh runs, and
  the console sends the browser a `refreshed` frame once that refresh lands. Stage evidence and each path's git root are
  served the same way, so a warm read spawns no git. Each row carries only what the board renders, and filters run on the
  server. Each stage sends at most 200 rows (`perStage`) with a count of every match. The home page asks for blocked tasks
  only.
- ce8b25c: A design round's frames now take a verdict and a comment. Each strip frame and each frame a question draws above itself shows Chosen, Rejected and Maybe (a second press clears the verdict) and a comment box. Pressing a frame makes it the active one: `c`, `x` and `m` set its verdict and `u` clears it, while digits answer only an active question. Send answers posts every frame that holds a verdict or a comment as a `rounds.submit` `variants` entry. The `feedback.json` write cap rises from 64 KiB to 256 KiB, so a 24-frame round with long comments and pins is no longer refused whole.
- 2c20516: Add an inbox withdraw verb and auto-withdraw self-healed alarms (TP-4112). owner-queue gains a `./withdraw` subpath (`withdrawDeposit`, `restoreDeposit`, `withdrawMatching`, `readWithdrawal`): a seat withdraws only its own deposit, with `<id>.withdrawn` beside it and never an answer file, and each withdraw and restore is appended to the spool's `withdrawals.jsonl`. It also gains `alarmKey`, `collapseRepeats` and an optional `repeats` on `OwnerItem`. `titan-console inbox withdraw|restore|withdraw-matching` exposes it (refusal 65, unknown id 66); the inbox lists withdrawn deposits apart from answered ones and collapses open repeats of one alarm into the newest. A verified console update withdraws its earlier update-failure items, and a factory deploy that holds withdraws the open deploy alarms and incidents, both as `resolved`.
- 5993fba: Let the owner approve a g10-held PR now and leave the merge to the adversary loop (TP-4003). A `merge-at-head` op may carry `waitFor: "adversary-loop"`. The factory then records a standing approval on the PR's Shepherd run, pinned to the confirmed head and to the g10 hold class the owner saw, and answers `approved`. The standing-answer sweep lifts the g10 hold as the owner once a g10 release Shepherd writes after the tap judges that hold met at that head, released or in shadow: the two-MERGE rule for `g10-adversary`, the single-MERGE release for `g10-review`. It then answers the run's approve-merge at that head. A new head, a hold escalated to another g10 class, a FIX_FIRST from the panel or the correctness reviewer, or expiry voids the approval and files a "Merge approval voided" owner inbox item. In the console, a g10-held merge-at-head shows "Merge without both MERGEs" (the forced merge, as before) beside "Approve; merge when the loop closes".
- 9c1123a: Rounds: a pick-one whose options pick exactly two frames answers as an A/B. Its sides draw side by side (stacked on a phone), each with its frame, a pick button and a note sent as `optionNotes`. Options that pick no frame, such as "Both", are buttons under the sides, and a required pick-one with no `revisionOption` offers "Neither: request a revision", sent as `revisionRequested` once the comment says what to change. feedback@1 is unchanged.
- b3bd733: A question or design round now checks before it sends. Check and send opens a summary of every answer by section: the pick, the comment and option notes, each judged frame's verdict and comment, and the round feedback. Unanswered questions are marked; Show only unanswered filters to them, and Answer next unanswered closes the summary on that question's page. Esc goes back to answering and Cmd or Ctrl+Enter sends. Required questions no longer hold the send (owner decision 513): with any question unanswered the button reads "Send partial: N unanswered" and still sends. A revision request with no comment still holds it, since the server refuses one.
- b9fc5c6: Every review round now takes free text. Each question of every kind, in question, design and Ship rounds, has an optional comment box, sent as that answer's `comment` with or without a pick. A comment alone does not answer a required question. Each round has a "Feedback on this round" box, sent as `general`. Once a round is sent, `rounds.get` carries the comments and the general text as `notes`, and the page shows them read-only.
- 7b302bf: Round pages take Enter to go to the next unanswered question (or, with none left, to the check screen), Cmd/Ctrl+Enter to open the check-before-send screen, and `?` or a Keys button to show a legend of every round key. Every round key handler and the legend now read one shared table, so they cannot drift apart (TP-3776).
- 5d88862: A round question's `frames` now draw above it, in question, design and Ship rounds. Each frame links back to its question and the question links to each frame. An option names the frame it picks ("(frame: <label>)", from `optionVariants` or an option that is a variant key), and a Ship question with frames says "Ships: <labels>". A design round's section strip leaves out frames a question draws. Questions without `frames` draw as before.
- e812187: Rounds: every required pick-one without its own `revisionOption` offers "None of these, request a revision", and a revision request (built in or the round's own option) marks its comment required, shows an alert until it has text, and counts as unanswered on the check screen until then (TP-3777). A round served with a `contrastOverride` shows its reason in a banner above the round (TP-3783).
- 5992c5a: A Ship round no longer ships while feedback is open. `rounds.get` returns an open Ship round's earlier feedback on the same unit as `priorFeedback`: each earlier round with a non-Ship pick, a revision request, a comment or a round note. The page shows each one above the Ship answer with an "Addressed" checkbox. Ship is disabled, with the reason written beside it, until every item is ticked and while the draft carries a change request: a comment, round feedback, or a side pick that differs from the implemented choice. Send back stays available. `rounds.submit` refuses a Ship pick for the same reasons. It takes the ticks as `addressed` and keeps them in an `addressed.json` file beside `feedback.json`.
- 5a1a146: A Ship round shows main vs head only. `rounds import` refuses a Ship round with more than one merge-bound question, an image frame with no main frame that is not marked new at head (`change: "new"` or "(new at head)" in its label), or exploration content, meaning alternatives side by side (an `alternate` column, or `A/B`, `proposal` or `alpha` in a key or label; a lab story new at head ships). Each refusal names the frame or variant and the rule. The Ship page labels each pair BEFORE (main) and AFTER (head), names what ships (PR, head and changed-frame count), shows changed frames first and folds unchanged pairs into an "N unchanged" disclosure. `rounds.frames` marks each frame `unchanged` when frames.json gives its base and head one sha256.
- a3555ea: Play a round's clip variants in the console: a `rounds.clip` byte-range route and a ClipPlayer with play/pause, loop, a scrubber and keyframe seeks (TP-3771).
- a3555ea: Play a round's audio variants in the console: a `rounds.audio` byte-range route and a small audio player with the variant's transcript (TP-3782). Blind-ab rounds stay refused.
- 6365309: The console's confirm sheet for an owner-at-head merge gate shows the factory's evidence card (TP-4492). `inbox.prepare` reads `gate.ownerEvidence` for a merge tap. A `missing` card, or one read at another head, offers no tap and names the terminal command. A ready card goes into the read-back and so into the confirm digest, and the record posts its `evidenceDigest`. The sheet heads each CI-policy section with the evidence's own reading (kind and keys). It lists every labelled line and the verdict text, and shows each changed file's rows. Every string renders verbatim, wrapped, never clamped or cut. In the factory, a card's CI-policy section now carries `verdictLines` and labelled lines through `exactLine`, in place of the raw `verdictText`, so a hidden or bidi character shows as its code point.
- 9ad67e7: Add `titan-console shipped build [--date] [--group] [--dry-run] [--force] [--json]`. It groups the day's PRs merged through Shepherd by initiative into batches of at most 40, reads each PR's title and body serially (bodies cut to 1 KB, reads stop at a GitHub 403), asks one sonnet `claude-print` call per batch for themes (at most 12 calls a build, $0.50 each) and writes `<stateDir>/shipped/<date>.json` for `coord.shipped`. PR numbers the model invents are dropped and PRs it omits are listed unsummarized. An unchanged PR set is a no-op without `--force`, and a logged-out claude exits 2 without writing.
- 51ee4c4: Add `@titan-design/png-delta`: the bounded PNG decoder and pixelmatch share moved out of the factory's shepherd, plus
  `pixelDelta` and `encodePng`. The factory now reads its visual-delta measure from the package, and the console's Ship
  Diff tab shows a base-vs-head delta image with its changed-pixel share for each changed frame (TP-2512).
- 9494e6f: Add `titan-console rounds subscribe | unsubscribe | list-subscriptions`, so any seat hears over agent-chat when the owner answers a round, a unit glob, or the Ship rounds of an `owner/repo#N`, including rounds imported later. Subscriptions persist in the console state dir. The asker from `decisions file` is now the round's first subscriber, and `rounds import --seat <name>` records one too. Each seat gets one notice per answer (`notified-<seat>.json`; the start-up sweep retries a failed send), an answer with no asker or subscriber goes to tp-operator, and the notice says whether the answer carries free text. Notices still go through `agent-chat debug send` and carry human provenance, now behind one transport seam.
- b5530eb: Design rounds show each section's parts as Current | Proposed code panes (settled parts folded with their cite), label a section strip CHOICE or STATES (TP-3779).
- bd4a97d: Draw a decision packet's options as cards on #/rounds (TP-3780): each card shows the option's detail, weak point and
  "If you pick this", is picked by its own radio or checkbox, and takes a note. An A/B side shows its option's detail too.
- 1de27cd: Ship rounds: each PR gets Review, Diff and Context tabs with its Ship bar under all three, Ship blockers link to the question, frame, earlier feedback or round note they name, stacked-base frames are labelled as context, and a stacked PR says which PR it ships after (TP-3784).
- b525328: Add the `blockers.banner` read. It lists what has waited on the owner for longer than `TITAN_CONSOLE_BLOCKER_HOURS` (whole hours from 1 to 720, default 12), oldest first, up to five, with the full count. Three sources count: open inbox deposits that carry a `blocker`, owner gates that a live pinned Shepherd run is pending on, and unsatisfied holds on such runs. The read gets the spool from its directory and Shepherd's active rows from one cached `shepherd.list`. It never calls `inbox.list`. A source it cannot read becomes a gap line, and the other sources are still listed.
- 3d709d8: Offer a forced retire on the agent page once agent-chat's grace has passed (TP-4600). `listAgents` passes through each row's `exitedAt`. The factory's retire-agent route sends `--force` only when the roster's exit time is at least two minutes old, and its preview reports `forceStop`. The console's Retire sheet reads back the exit time and offers "Retire and discard" only when `forceStop` is null, with the same CHANGED re-check at act time.
- 20c93ed: Record who actually withdrew an inbox deposit (TP-4121). `withdrawDeposit`, `restoreDeposit` and
  `withdrawMatching` take a required `actor`, refuse a blank one, and write it beside the asker
  (`by`) in the `<id>.withdrawn` marker and every `withdrawals.jsonl` row. A marker from before
  this has no `actor` and still reads. `WithdrawnItem` gains an optional `actor`, which the
  console's inbox read model fills from the marker.

  `titan-console inbox withdraw|restore|withdraw-matching` take a required `--actor <seat>`; a
  missing one exits 65 with one line on stderr. The console updater and the factory deployer
  record their own names as actor when they auto-withdraw resolved alarms.

### Patch Changes

- 3f096e4: Resolve the default `agent-chat` binary on PATH at config load, so seats are told when their rounds are answered. When it is not found, seat notices are off and `serve` prints one warning naming `TITAN_CONSOLE_AGENT_CHAT_BIN`.
- fc013fd: Fit the Agents, Sessions and Home pages to a phone. Below the `md` breakpoint the agent roster, an agent's runs and the sessions list stack into cards instead of tables whose columns overlapped, and the agent card wraps a long name instead of cutting it off. Their tabs, breadcrumbs, task, agent and PR links, and the home inbox link are 44px tap targets. Desktop layouts are unchanged.
- 6b7ee32: The console's `#/autoresearch` run page reads and shows C-256 S5's read model. Each round lists its ratchet moves and the later winners measured again on the new head, with decision, reason and Δ. A new Snapshots section lists the snapshot PRs, any cut waiting behind the open one, and each sync with its state, conflicts, frozen paths, a failed sync's reason, gate and B's re-measure. The runs list names the open snapshot, and the idea record names a re-evaluation. `reeval:<reason>` reject codes now read as text. A factory from before S5 still parses, with every new section empty. A sync's re-measure never reaches a ladder, and no `sync` rung is admitted. In `@titan-design/autoresearch`, the console schema copies used by tests now carry these fields, which replace the proposed copies.
- 860bc9f: Add a broker verdict client that posts permission and endorse verdicts to agent-chat's `/api/queue/:msgId` routes under the console owner channel. It is not wired to the inbox yet.
- 992f9d7: The round check before sending lists each pinned frame's pin count and pin notes, and the digit-in-field round test now reaches the window key guard it covers.
- 0a049a1: After a verified swap, `self-update --apply` writes a `titan-console` shim to `~/.local/bin` (`TITAN_CONSOLE_BIN_DIR`) that runs `current/apps/console/dist/cli.js` with its arguments, so seats call `titan-console` from `PATH`. It names `current/`, so a rollback keeps it valid; an unchanged shim is not rewritten, a new one is renamed into place, and a failed write is logged without failing the update.
- abf8bcf: `config import` now writes rev 0 into a coordinator revision log that exists but is empty. Before this change it refused with "another writer created rev 0 first". Rev 0 is claimed with an `O_EXCL` sibling file, so two concurrent imports still cannot both write it.
- ac664c0: Add `titan-console decisions file [<round.json>|-] [--seat <name>] [--initiative <slug>] [--json]`. A seat pipes a questions-only round@2 round on stdin and it lands in the console's own rounds dir as `<unit>-r<round>/` beside an `asker.json` naming the seat (default `AGENT_CHAT_NAME`) and initiative; the verb prints the round id, the asker and the `/#/rounds/<id>` URL. A round with variants or a merge-bound Ship question, or one the round@2 parser refuses, is refused and nothing is written. Once the owner sends the round, the round listener tells the asking seat through `agent-chat debug send` (`TITAN_CONSOLE_AGENT_CHAT_BIN`, default `agent-chat`) with a fixed-text message naming the round and its `feedback.json`, and keeps `notified.json` so it is sent once; a failed send is retried by the start-up sweep.
- 32968aa: `videos.edits` keeps each video's edit list until a ledger file, the run state or the CLI release changes, so a repeat read no longer spawns `explainer edit list`. A failed read is never kept.
- 3bc3e7a: Make `inbox.list` fast and small: the factory's needs.list and Shepherd's finished runs are kept for 15 s and served for up to 5 min while one refresh runs behind them (an `inbox.act` drops them), the finished runs are read beside the queue instead of after it, rows leave out the `context`, `anchors`, `pins` and recommendation rationale and cite the page never renders, and the default view only counts the planning items (`planningCount`). The inbox page reads them with `{ planning: true }` when the Planning section opens.
- 783bc33: Drop the inbox's kept factory and Shepherd reads when a round is answered through `rounds.submit` or `rounds.answer-rec`, both once the feedback is written and again once the gate listener settles, so an answered round and its gate leave `inbox.list` on the next call. `approvals.flow` now shares the inbox's kept factory read.
- afc4124: Fit Knowledge and Review rounds to a phone. Below the `md` breakpoint the Knowledge list shows cards instead of a table. The search row wraps, and a record's long ref breaks inside its breadcrumb. On both pages tabs, radios, buttons, inputs and the round-set links are 44px tap targets. On a phone, Ship, Send back and a multi-PR round's Send answers each show a confirm step before they write. The desktop layout is unchanged.
- 94b7c76: `rounds.submit` takes an optional `liveViewed`: the round's variant keys whose live story rendered on the owner's page, deduped, bounded at 200, and refused when one is no frame of the round. Once feedback.json is written, the decision log appends one line to `$TITAN_CONSOLE_STATE/live-viewed.jsonl` with the keys and the round's Storybook build id (null when it carries none), so an audit can tell an approval made from the PNG from one made after live exploration. feedback.json and its strict schema are unchanged, and no carry rule reads the line. The round page tracks the rendered keys and sends them with its submit (TP-3793 S7).
- d9f9cd0: A multi-PR round's live-viewed log row records each viewed key's own PR group build in `builds`; a single-build row is unchanged.
- 751958b: `titan-console login-link` names a host the LAN certificate covers: the first of `TITAN_CONSOLE_LAN_NAMES` it covers, else the certificate's own name, so a bare run with the hostname defaults no longer prints a link that warns on TLS and gets 403 from the Host check. With `TITAN_CONSOLE_TLS_CERT` unset it reads the one `.crt` under `<state>/tls`, and it refuses when it finds no certificate.
- 3d16eb2: The gate-answer listener relays every merge-bound question of a multi-PR round, one post per PR to its own gate. A round with one merge question keeps its `answer.json` unchanged; a round with several keeps the first PR's record on top and adds `answers`, each PR's request and outcome under its question id.
- 3d16eb2: A Ship round's earlier feedback reads every PR's merge question of an earlier multi-PR round. Each PR's entry carries `pr` and its own pick, comments and frames, and blocks only that PR's Ship: a Don't ship on one PR no longer holds another.
- 81395d7: Round and video-note notices go out through `agent-chat debug send --source console`, so a seat sees them labelled `wake_source=console`, without human provenance, instead of as the owner typing.
- 870415a: Below the `md` breakpoint, replace the 60px nav rail with a menu button in the top bar that opens a drawer listing every route. The current route is marked and takes focus, each link is a 44px tap target, and the drawer closes on a tap, on Escape or on the backdrop. The desktop rail is unchanged.
- 9079921: A design round's pin draws only on the render of the width it was placed at, so a pin placed on a variant's 390 px
  render no longer shows at the same percentages, in the wrong place, on its 1440 px render or its captured PNG
  (TP-3964). Sent pins now read back their width; a pin with no width still draws on every render.
- 35a44d6: Depend on `@titan-design/react-ui` ^0.21.2, the release the codewatch app already uses, so the workspace installs one copy.
- 6d82097: Depend on `@titan-design/react-ui` ^0.23.1, with codewatch, so the workspace still installs one copy. The autoresearch run header shows its stats as react-ui `StatCard`s instead of `DataRow`s, with the run status beside the title.
- 482e849: Give the Inbox, Initiatives, Reviews, Shepherd, Autoresearch and Config pages 44px tap targets below the `md` breakpoint: links, tabs, chips, accordion headers, small buttons, the initiative brief's section steps, table sort headers and the idea drawer's close button. On a phone the inbox's one-tap "answer all with recommendation" arms a confirm step before it submits the round. The desktop layout is unchanged.
- 73533e5: Nudge rounds left unanswered over six hours: the inbox lists each one once with its recommendations stated, `titan-console rounds nudge` prints its "reply rec" line once (a `nudged.json` marker keeps it from repeating), and the new `rounds.answer-rec` owner write answers every question with its recommendation through `rounds.submit`, marked `answered-by-rec` (TP-4044).
- 46a4fad: Stop a round question's card from moving under a press. The card was a pressable Card, whose press scale and hover lift held while any radio or text field inside it was pressed, so a tap could slide the radio away before it registered and typing a space nudged the card. A click anywhere in the card still makes it the active question; only buttons keep their press.
- 425bbac: Ship rounds follow owner decision 513: Send back only needs a note. Unanswered required side questions no longer hold it, and go with it as unanswered. Send back stays off, with the reason beside it, until there is a comment on the Ship question or a round note, the only text the fixer receives (the factory refuses an empty note). `rounds.submit` refuses a Send back with neither, with the same reason, and writes nothing.
- 57072e4: Ship rounds: the Ship and Send back card now comes after every question, so an answer to a question below the Ship decision is sent with it, and the side questions lock once the answer is sent. An unanswered required question no longer turns Ship off (decision 166); it still holds Send back. Ship rounds share the round answer state, so digit keys answer the active question, a question over two frames draws as an A/B and its option notes are sent.
- 8adedc7: Add the `titan-console-shipped` systemd service and timer template (07:10 local, builds the day window that just closed) and the README section for installing it. Not installed or enabled by anything in the repo.
- 02999c3: `self-update` now smokes a new release with that release's own check, through a new internal `self-update --smoke <release> <sha>` verb, so a fix to the smoke check deploys on the pass that builds it (TP-3938). A release without the verb falls back to the updater's own check. A smoke failure now ends with the last 20 lines of the smoke daemon's or verb's stderr, in the record and the owner-queue alarm, and a daemon that exits stops the wait at once (TP-3935).
- c018e28: Self-update's smoke build runs with the story origin off (`TITAN_CONSOLE_STORY_PORT=0`). It inherited the default story port 7501, which the served console already holds, so the bind failed and every smoke reported that `/health` answered with nothing.
- 47f34b8: The console build no longer fails when git is unavailable (no `.git`, or a checkout another user owns). `stamp-build` warns, removes any earlier `dist/build-info.json` and exits 0, so `/health` and the footer report an unstamped build.
- 888c9e0: Take a tap sheet's Confirm pressed the moment its read-back appears. The button used to keep its disabled press handler until a later effect ran, so a quick press was silently dropped.
- efdf729: Mark a confirm sheet's reading spinner with a test id, so tests open every sheet through one helper that waits for the prepare's read-back instead of racing it (TP-4634).
- 6ea379b: Stack the Tasks list into cards below the `md` breakpoint, so a phone shows each task's id, stage, title, stage reason, initiative and severity without the table's columns overlapping; each card's task link is a 44px tap target. The desktop table is unchanged.
- 25c65f6: The console update now runs from a small fixed bootstrap (`deploy/titan-console-bootstrap.mts`) (TP-4043). It fetches, builds origin/main into `releases/<sha>`, and hands off to that build's own `self-update --apply <sha>`, so a fix to the updater applies on the pass that builds it instead of being judged by the installed copy. The updater keeps the previous release until the new one answers `/health` with its sha within 60 s, rolls back otherwise, and files the owner-queue alarm through `alarm.ts`. The bootstrap's build and hand-off failures file the alarm through the serving build's new `self-update --report`. A bare `self-update`, which the timer unit from before this change runs, runs the serving release's copy of the bootstrap, so that unit migrates with no owner step; copying the bootstrap outside the app is optional hardening.
- 12b8cc9: Flush a new release to disk with `sync -f` and read it back before the self-updater swaps `current` to it, and refuse the swap (stage `flush`) when its `dist/cli.js` or `dist/index.html` is empty or its build-info names another sha. A new `ExecStartPre` start check moves `current` off a build a power loss left empty, or fails the start with the reason, and the bootstrap rebuilds a release whose stamp is empty.
- e16743e: The theater's video sidecar parser accepts an optional `explainer` block (video id, up to 50 run ids, profile, script sha, and an opaque fingerprint up to 32 KB). A larger or malformed block still counts as an unreadable sidecar; sidecars without it parse unchanged.
- 9d3a848: `work.task` no longer reads every initiative's done tasks to find one id, which passed active-work's read timeout and answered 500 every time. It finds an open task in the open list the stage already reads, and a done task with `task.show` in the initiative whose brief claims the id's prefix (one initiative's `task.list` on a daemon without `task.show`). A timed-out `context.graph` or `artifact.status` now marks mentions (new `mentionsDegraded`) or PR state unavailable instead of failing the page. `children` lists open children only.
- 7b50f4c: Decode and diff a changed frame on a worker thread, so a first view of a large frame delta no longer holds the daemon event loop (TP-4687).
- a5f2f40: Let `withdrawDeposit` and `restoreDeposit` take a short deposit id (TP-4122). Besides the full
  `deposit:<32 hex>`, either takes a hex prefix of at least 8 digits, bare or after `deposit:`, that
  starts exactly one deposit in the spool, and reports the full id. An ambiguous prefix is refused
  with every full id it matches; no match is `unknown` with `unknown id <x>; full form is
deposit:<32 hex>`. Only an id of another item kind (`gate:`, `round:`) is refused as not a
  deposit. The asker, actor and answered checks run on the resolved deposit as before.

  `titan-console inbox withdraw|restore` pass the id through: an ambiguous prefix exits 65 and an
  unknown one 66.

- 0498518: The inbox's Approve merge rows and their confirm sheet now show the Ship lineage line (proven-at, merged or UNMERGED, main tip, how many behind), read from the round page's cached lineage reader so a row adds no read of its own; a gate whose lineage is unread shows "lineage unknown".
- 09dfe30: Ship rounds with several PRs: an earlier round's Addressed tick on one PR's card no longer ticks the same round on another
  PR's card. The page and the round draft key each tick by PR; a draft saved before still restores, and `rounds.submit`
  still records round numbers only (TP-3885).
- 09dfe30: Ship rounds: a PR stacked on another PR of the round cannot ship while that PR is answered Send back. The Ship bar names the
  holder and links to its Ship question, and `rounds.submit` refuses the same Ship (TP-3883).
- 41c2c45: The console inbox gives an agent-chat permission prompt or endorsement an `approve-chat` tap. `inbox.prepare` reads the broker's own queue row back (tool, input preview and description, or the exact stored text and recipient) and offers no tap for any other row. `inbox.act` posts the owner's allow, deny or endorse verdict through the broker verdict client once, and a refusal names the terminal command.
- a276489: The inbox page takes an agent's permission prompt or endorsement from the console. A permission read-back shows the tool, the input preview in a scrollable block and the agent's description, with Allow and Deny. An endorse read-back shows the recipient and the exact stored text with its whitespace kept, with Endorse. Each tap sends only its verdict to `inbox.act`.
- 8a470d5: `config.compareTree` no longer returns an absolute filesystem path: an unexpected fs error on the revision log (EACCES, ENOTDIR and the like) is replaced by `cannot read <path relative to the state dir>: <code>`, and an unreadable tree file or directory names its errno code beside its tree-relative path.
- 57b3b2d: Send answers on a round responds in about one human-only read: the decision log records a round's answers as one batch that reads the active-work inventory once, not once per answer, and the round listener (gate answers, seat notices) runs after the response instead of holding it (TP-4001).
- 9bcdd77: A deposit's resolve-gate op offers the gate's own tap only while that gate is still open at the head the deposit named; once the gate is answered or its head moves, the card says so instead.
- f8b53af: When the session graph is older than the console, the Sessions, session and agent pages now list the missing migrations and the fix (upgrade active-work, then run `active miner refresh`) instead of only saying the graph is older than this console.
- cf03697: Answer an agent's chat question from the inbox behind a fixed outcome preamble (TP-3630). The text sent to the broker now starts with one line naming the chat msg it answers and asking the agent to record a durable outcome on that item (task note, PR comment or reply). The action record and the decision log keep the owner's words unchanged.
- 012afa2: The twin capture now fails on a Google Fonts request, as it does on any other request off disk (TP-3641). react-ui ships its web fonts and the build inlines them, so the twin no longer lets that request fail quietly. The README's twin table says which text still falls back to the system sans.
- 8d72b53: Bound the Ship lineage GitHub read to 5 seconds so a stalled GitHub marks lineage unknown ("github timed out") instead of hanging rounds.get (TP-3680).
- c8b32f6: A round notice the start-up sweep's retry still cannot send now shows in the inbox as a read-only row naming the round, the seat and the error; the next send that reaches the seat clears it (TP-3756).
- a7eecba: Keep the earlier feedback and its Addressed ticks on a sent multi-PR Ship round, locked as sent.
- 60dc20e: The inbox no longer lists a parse-error gap for a withdrawn round (TP-4049).
- 6d79a8b: Add `promptLine` and `PROMPT_LINE_BREAK` to `@titan-design/owner-queue`: one cleaner for author- or agent-written text bound for an owner prompt, which drops ANSI escape sequences, C0 and C1 controls and every format character (bidi overrides and isolates, zero-width and tag characters) and flattens CR, LF, NEL, U+2028 and U+2029. The D21 ci-policy card, the console's decisions-file line and the Shepherd wake brief's review comments now all use it, so the decisions line also drops bidi and escape sequences, the wake brief strips them from comment paths and bodies (a verdict line behind a bidi override is now quoted), and the ci-policy card also drops tag characters and soft hyphens.
- 222d69a: `rounds.list` carries a withdrawn round's `withdrawnReason`, and #/rounds lists withdrawn rounds in their own Withdrawn section with that reason, linking a `superseded-by:<id>` reason to the round that replaced it, instead of dropping them from the page; Open still lists only open rounds. Window focus, or the tab turning visible, refetches `rounds.list`, so a round withdrawn after the page loaded leaves Open without a reload (TP-4335).
- 79f91dc: The inbox reads every round the console's strict review-schema 0.3 reader accepts as one row, where a round only 0.3 knows used to be an unreadable gap: the validated manifest is projected onto the 0.1 fields owner-queue reads until TP-3232 installs 0.3 there. A hitl gate folds into an open round's row, listed in its `foldedGates`, only when it is its live run's pending approve-merge or visual accept gate at the PR head a merge-bound question pins: exactly the gate the round's answer posts to. Any other step, such as sh-sent-back, and any other head keep their own row. The answer relay and the fold now share that predicate (`round-gate-cover.ts`), so the relay also finds a Shepherd row that spells the repo or head in another case.
- 6db8c62: The owner blocker banner no longer counts a G10 hold (`g10-review`, `g10-adversary`): those wait on a reviewer, not the owner (TP-4559).
- f6380e0: The agent page's card ellipsizes a long agent name, status line and facts line at phone width instead of clipping them, and carries the full text in a title attribute.
- Updated dependencies [ff061ba]
- Updated dependencies [9386796]
- Updated dependencies [59db533]
- Updated dependencies [c1af4ba]
- Updated dependencies [73c018b]
- Updated dependencies [74ad076]
- Updated dependencies [81395d7]
- Updated dependencies [9411e94]
- Updated dependencies [dcbf00e]
- Updated dependencies [e391005]
- Updated dependencies [d0d51f1]
- Updated dependencies [f85e2ba]
- Updated dependencies [e8159b1]
- Updated dependencies [cca108a]
- Updated dependencies [b7c8320]
- Updated dependencies [581c26f]
- Updated dependencies [25fcc67]
- Updated dependencies [b458a20]
- Updated dependencies [83a5759]
- Updated dependencies [4ea511b]
- Updated dependencies [2917ad8]
- Updated dependencies [d666020]
- Updated dependencies [74fe992]
- Updated dependencies [6889f5d]
- Updated dependencies [7492819]
- Updated dependencies [1ac0fa2]
- Updated dependencies [24f1577]
- Updated dependencies [7b901b2]
- Updated dependencies [2242334]
- Updated dependencies [9b03130]
- Updated dependencies [5ada6c1]
- Updated dependencies [211db45]
- Updated dependencies [5ba850e]
- Updated dependencies [f896485]
- Updated dependencies [9c70c14]
- Updated dependencies [708e154]
- Updated dependencies [6a2471a]
- Updated dependencies [56d107b]
- Updated dependencies [0848c31]
- Updated dependencies [136b507]
- Updated dependencies [f5d92f3]
- Updated dependencies [292fbe9]
- Updated dependencies [ed8310b]
- Updated dependencies [fa9516b]
- Updated dependencies [26598f3]
- Updated dependencies [792265b]
- Updated dependencies [db5ea61]
- Updated dependencies [e8fbf15]
- Updated dependencies [974b429]
- Updated dependencies [5f2d9ed]
- Updated dependencies [d3d9a04]
- Updated dependencies [123f2d0]
- Updated dependencies [7b53127]
- Updated dependencies [dcaebb9]
- Updated dependencies [24f1577]
- Updated dependencies [b3209e3]
- Updated dependencies [a5f2f40]
- Updated dependencies [2c20516]
- Updated dependencies [2380fd4]
- Updated dependencies [7a34209]
- Updated dependencies [bea67f1]
- Updated dependencies [5993fba]
- Updated dependencies [f15a84e]
- Updated dependencies [5cd2a5a]
- Updated dependencies [cda1b03]
- Updated dependencies [7835f1b]
- Updated dependencies [ca8e8b7]
- Updated dependencies [f896485]
- Updated dependencies [0b40e0f]
- Updated dependencies [5fd32b6]
- Updated dependencies [a20c348]
- Updated dependencies [b6ce883]
- Updated dependencies [b6ce883]
- Updated dependencies [820d4d2]
- Updated dependencies [6554538]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [423c9ce]
- Updated dependencies [c58d555]
- Updated dependencies [1640772]
- Updated dependencies [8b92ba0]
- Updated dependencies [36dc03f]
- Updated dependencies [f3d3107]
- Updated dependencies [c9f7746]
- Updated dependencies [a2df0c0]
- Updated dependencies [a2da8ac]
- Updated dependencies [0b09ff1]
- Updated dependencies [6525ba7]
- Updated dependencies [661a027]
- Updated dependencies [9dd8d1c]
- Updated dependencies [207a81b]
- Updated dependencies [207a81b]
- Updated dependencies [f1d79a5]
- Updated dependencies [f77d79d]
- Updated dependencies [9b42150]
- Updated dependencies [05895cd]
- Updated dependencies [8e09d50]
- Updated dependencies [b672645]
- Updated dependencies [37d60d1]
- Updated dependencies [63ccb71]
- Updated dependencies [cd8a1ce]
- Updated dependencies [00fb3ee]
- Updated dependencies [c1f9297]
- Updated dependencies [b8e2df5]
- Updated dependencies [5f33d7a]
- Updated dependencies [4080191]
- Updated dependencies [e63d1a9]
- Updated dependencies [661cf66]
- Updated dependencies [9b2057c]
- Updated dependencies [5f2b39f]
- Updated dependencies [51ee4c4]
- Updated dependencies [5e34e3d]
- Updated dependencies [52dc7f3]
- Updated dependencies [869014a]
- Updated dependencies [32637bd]
- Updated dependencies [2451aa9]
- Updated dependencies [d130bd8]
- Updated dependencies [cb470f4]
- Updated dependencies [2f306ce]
- Updated dependencies [181c229]
- Updated dependencies [49fa132]
- Updated dependencies [6d79a8b]
- Updated dependencies [d2cce6c]
- Updated dependencies [59b27e3]
- Updated dependencies [db14121]
- Updated dependencies [5833044]
- Updated dependencies [fcb7e85]
- Updated dependencies [719f05e]
- Updated dependencies [36e0a48]
- Updated dependencies [3d709d8]
- Updated dependencies [147ff5d]
- Updated dependencies [4eb9812]
- Updated dependencies [1bc6431]
- Updated dependencies [449504e]
- Updated dependencies [84114b3]
- Updated dependencies [9028bd0]
- Updated dependencies [9396ce4]
- Updated dependencies [29062e0]
- Updated dependencies [9d74995]
- Updated dependencies [78ae7d9]
- Updated dependencies [8031169]
- Updated dependencies [20c93ed]
- Updated dependencies [247171d]
- Updated dependencies [9ad447f]
- Updated dependencies [d5e44a5]
  - @titan-design/agent@0.7.0
  - @titan-design/agent-dispatch@0.10.0
  - @titan-design/github@0.12.0
  - @titan-design/session-analytics@0.18.0
  - @titan-design/owner-queue@0.6.0
  - @titan-design/coordinator@0.6.0
  - @titan-design/fix-proof@0.9.0
  - @titan-design/daemon@0.9.0
  - @titan-design/decider@0.7.0
  - @titan-design/session-read@0.17.0
  - @titan-design/session-graph@0.19.0
  - @titan-design/worktree@0.4.0
  - @titan-design/react-app@0.2.0
  - @titan-design/registry@0.6.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/chat-protocol@0.3.1
  - @titan-design/rpc-client@0.4.2
  - @titan-design/png-delta@0.1.0

## 0.12.3

### Patch Changes

- ff8b628: Add the coordinator config store: an append-only revision log under `<state>/config/`, a materializer that writes the head document to titan-coordinator's config dir by temp file, fsync and rename, a shadow import of an autonomy tree that must round-trip through `renderSeatBook`, the `config.compareTree` read, and `titan-console config import` / `config compare-tree` for the owner's one-time rev 0. The compared tree is the one `TITAN_CONSOLE_AUTONOMY_DIR` names, the same tree `config.surfaces` reads.

## 0.12.2

### Patch Changes

- fce0e08: A round's merge offer must say which head it merges. A pick-one with a "Merge #N" or "Ship" option, or a signsOff naming "#N at <sha>", needs a `merge` binding whose pr and head agree with that wording. Otherwise `rounds import` refuses it. A round already in the rounds dir still lists and takes a submit; the list marks an unbound one "unbound: no merge tap".

## 0.12.1

### Patch Changes

- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
  - @titan-design/worktree@0.3.0

## 0.12.0

### Minor Changes

- 14e5db5: A question round can be answered in the console. It sends its picks and text through `rounds.submit` with the same Send answers card a design round uses, shows the sent or already-answered state and the revealed recommendations afterwards, and shows the server's refusal when the session cannot write. The "Read-only" notice is gone.

### Patch Changes

- fc50f10: Add the round feedback adapter: it builds a feedback@1 document from the owner's posted answers, with each recommendation echoed and `agreed` set only on an answered question, mirroring the review harness (TP-1988).

## 0.11.0

### Minor Changes

- 3267b54: Add `GET /media/videos/:id/poster` and the `videos.resolve` command for the Theater, and a `poster` field in the video sidecar (TP-3707, TP-3711).

### Patch Changes

- fc9e56d: Round notes read as text: a section's changed and context lines, and the round's own context, show as body text in the primary colour with their line breaks kept, and each "LABEL:" (such as WHY WAITING) is a quiet label row above its value. The "Context only:" prefix is gone.

## 0.10.0

### Minor Changes

- c6d2ead: The theater list becomes a feed: renders are sectioned by day in the reader's timezone with a count and total run time per day, each row carries a purpose pill (the sidecar `purpose` first, then a fallback cascade), an Old take or Phone flag and a byline, and search (`?q=`), purpose chips with counts (`?tag=`) and old takes (`?old=1`) live in the URL. Clips wait behind their chip, folded copies are counted, and an empty result offers Clear.

## 0.9.0

### Minor Changes

- 49eed0a: `videos.list` reads each video's headers (mp4 `mvhd`/`tkhd`/`hdlr`, webm EBML) into `durationS`, `width`, `height`, `orientation` and `audio`, caching them by device, inode, size and mtime. A file whose headers cannot be parsed becomes a gap line. Rows also gain a derived `title` (render notes H1, then BRIEF.md H1, then the stem, with the take appended when siblings share a title), `description`, `series`, `take` and `superseded`, each beaten by a sidecar value; `copies`, folding identical files under `copies` or `intermediate` folders; and `openNoteCount`, the open notes under the agent pickup rule.

## 0.8.0

### Minor Changes

- adb1f25: Read a `titan-console/video-meta@1` sidecar (`<stem>.video.json`) and a `titan-console/video-folder@1` manifest (`_videos.json`) into `videos.list`. Each row gains whichever of `purpose`, `tags`, `subject`, `parent`, `posterAtS`, `alias`, `title`, `description`, `series`, `take` and `status` are set. A sidecar beats the manifest. A bad file becomes a gap line instead of a failed list. A video with neither file lists as before.

## 0.7.0

### Minor Changes

- 940abfc: Show a Ship round's lineage before the owner taps Ship: the proven-at sha, merged or UNMERGED, the PR base's tip and how many base commits the proven head lacks, with a stale head marked. `rounds.get` carries it as `lineage`, read from GitHub and cached per binding for a minute; anything unread shows "lineage unknown" with its reason.

### Patch Changes

- 06feba3: The inbox action tests import `CONFIRM_TTL_MS` from `owner-tap.ts`, so `inbox-actions.ts` no longer re-exports it.

## 0.6.2

### Patch Changes

- c158727: Home, initiatives and an initiative's detail no longer scroll sideways on a 390px phone: the initiative title, the initiative cards and the upstream cards shrink to the row they sit in.
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [6dd2f97]
  - @titan-design/session-graph@0.18.0
  - @titan-design/session-read@0.16.1
  - @titan-design/session-analytics@0.17.4
  - @titan-design/worktree@0.2.0

## 0.6.1

### Patch Changes

- 2b90758: The `#/config` page gains a Hosts section from `config.hosts`: each other host's name and last report time. A host whose report is older than 25 hours is marked "not reported". The section is read-only.
- 28aa920: Extract the owner-tap kernel (confirm store, digest, write-once record and outcome files) from the inbox actions into `owner-tap.ts`, and turn the inbox confirm sheet into a generic `TapSheet`. No behaviour change.
- 30b0b10: Every routed console view renders inside a page shell that gives it a gutter beside the rail, a width cap and, on list views, the view's title as its heading.
- 847d56e: `inbox.list` gains `derived`: machine-raised rows for Shepherd stalls past 15 minutes in phase, runs that failed in the last day, and agents blocked for more than 15 minutes. Each row carries its evidence (what was observed, the source, and since when) and the threshold it crossed, and links to the run's timeline or the agent page. Derived rows have no action and sit beside `items`, so `inbox.act` never acts on them. A row without evidence is refused at construction. The inbox page shows them under "Raised by the console" with no button.
  - @titan-design/session-analytics@0.17.3

## 0.6.0

### Minor Changes

- 60672e9: Show one shell-level status line while the console's live event stream is down: "Live updates are off. Data may be old since <time of the drop>." Every page gets it, and it clears when the stream reopens. A stream that never opened on load shows no line.
- bf71eea: Add pause-to-comment, scrub markers and verdicts to the theater player. "Comment at m:ss" pauses the video and stamps the note with the presented frame's `mediaTime` from `requestVideoFrameCallback`, falling back to `currentTime`. On a phone the bar is fixed along the bottom of the screen. Ship and Needs changes append a verdict at the frame on screen. A refused owner write is shown verbatim. A strip under the video carries one tick per note on the current render, and tapping a tick seeks to it.

### Patch Changes

- 35b246d: Add the `config.drift` read command: one row per value kept in several config files (the worktree cap per repo across the home CLAUDE.md, the charter, agent-chat's `config.json` and `burndown.config.json`; the load5 hold; a lone roster seat's implementer cap against `maxAgents`), listing every copy's file, line and value. A row is `drift` when any two copies disagree. `config.surfaces` gains a `claude-md` row with the worktree cap the home CLAUDE.md states, and nothing else from that file.
- 81e9f8e: Add the read-only `#/config` page: every `config.surfaces` row grouped by surface, led by the `config.drift` rows whose copies disagree. A row with a file line shows the exact command that opens that line, with a copy button; a hidden row shows only "present", never a value. The page has no edit control.

  The console frame now grows with a long page instead of stopping at the viewport height, so the rail runs the full length of every page.

- a6fd5c9: Add the `config.surfaces` read command: it lists the coordinator config files (charter and seat front matter, `burndown.config.json`, the owner switches in `seat-watchdog.json`) as rows with value, file, line, the inline comment and the decision numbers it names, plus each file's mtime and newest hand backup. Each surface declares an allowlist of safe fields; any other key is a hidden row with no value, and a parse failure names only the error code and line. `TITAN_CONSOLE_AUTONOMY_DIR` points it at the autonomy tree and `AGENT_CHAT_HOME` at the agent-chat files.
- 24e56e2: `config.surfaces` no longer reads a `README.md` or a dotfile in the autonomy `seats/` directory as a seat. The surface specs move from `catalog.ts` to a sibling `specs.ts`, with no change in behaviour.
- c5f0166: Add a structure test that walks the served registry: every `config.*` command is owner-write unless its verb only reads, and no read or deposit command changes a config file.
- e6ef8da: Add `pnpm --filter titan-console capture`, deterministic twin captures of every console route. It renders the built page from disk with no daemon, from fixtures typed against `ConsoleCommands`, and shoots each route twice at phone and desktop widths. It fails on any byte difference between the two shots, and writes the frames and a `manifest.json` to `dist/twin` for visual review packets. `work.*` reads take an optional `now` clock for their `fetchedAt`.
- 2e60fe4: Add the Reviews tab: a list of repo reviews newest first, and a review detail with the summary, findings filtered to P1 and P2 by default with sort chips and windowed rows, and the audited claims.
  - @titan-design/session-analytics@0.17.2

## 0.5.0

### Minor Changes

- 2f149af: Add the theater's notes store. `videos.note` (owner-write) appends a timestamped comment or a Ship / Needs changes verdict to `<name>.notes.jsonl` beside the video. Each line is a strict `titan-console/video-note@1` object bound to the render's sha256. `videos.notes` reads them back, each marked `current` for the render now on disk, and `videos.list` gains `noteCount` and `verdict`. The README documents the schema and the agent pickup rule (`openNotes`).
- 0c4f033: Add the Theater page: every rendered video grouped by folder with verdict and note badges, and a player with captions, a notes list that seeks on tap, earlier-render notes dimmed, and `#/theater/<id>?t=<seconds>` links that open paused at that time.

### Patch Changes

- 3aa4dc2: Add the `reviews.get` read. It returns one repo review: its SUMMARY markdown capped at 256 KB with a `truncated` flag, the coverage line, the recommendations (or a gap line when the SUMMARY has no recommendations heading), every topic row and the claims rows. The name is looked up in the scanned set of review folders and never joined as given, so an unknown name or a `../` path gets a NOT FOUND refusal that does not echo it.
- a587427: Add `reviews.list`, the read side of the Reviews tab. It scans one level of `TITAN_CONSOLE_REVIEWS_DIR` (default: the repo-review folder under the active-work root). Each subfolder with a `README.md` is a review. The command reads fixed paths in each one, no-follow and capped at 1 MB, parses them with `@titan-design/pm`'s review-folder parsers and caches them by mtime and size. Each review comes back with its pin, its label (`current-label`, else `flat`), P1 and P2 counts, claims, coverage, headless cost, and a state that a rule table in `server/review-rules.ts` derives from the files. The README's status line is never used for the state. A label that is not a plain name, a symlinked file or dir, and a file that fails to parse each show up as a gap line instead.
- 41fce70: Check a recommendation's cite against its transcript when the deposit is filed.

  - `@titan-design/evidence`: `quoteInText(text, quote)` matches a quote against any text. It normalises whitespace and line wrapping the same way `quoteInRange` does, and `quoteInRange` now calls it.
  - `@titan-design/owner-queue`: `recommended.cite` takes legacy free text or a strict `{session, event, quote}`, where `event` is `<byteOffset>:<byteLength>` of one transcript line (`locatorCiteSchema`, `LocatorCite`). A consumer that read `cite` as a string must now handle the object form too. `writeDeposit(dir, deposit, { events })` throws `DepositCiteError` and writes nothing for a locator cite whose quote does not match the event text, an event that cannot be read, an empty quote, or a call with no `events` source. Free text is never checked.
  - `@titan-design/session-read`: `readSessionEventText({session, byteOffset, byteLength}, { roots })` returns the message text of one whole Claude transcript line. It returns null when the session is not in exactly one transcript or the span is not one whole line.
  - `titan-console`: `inbox.deposit` checks locator cites through session-read and answers 400 when the check fails.

- Updated dependencies [41fce70]
  - @titan-design/owner-queue@0.5.0
  - @titan-design/session-read@0.16.0
  - @titan-design/decider@0.6.6
  - @titan-design/session-analytics@0.17.1
  - @titan-design/session-graph@0.17.1

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
