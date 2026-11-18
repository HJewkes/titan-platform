# @titan-design/pm

## 0.11.0

### Minor Changes

- d025aac: Add `agentAccess`, the one verdict on whether agents may read an initiative: shown only when the brief is agent-visible and a readable charter does not list it human-only. An unknown charter withholds everything (TP-5556).
- ce68429: Add `parseIntentDigest`, a strict reader for the `titan-intent-digest/v1` owner-intent digest format.

## 0.10.0

### Minor Changes

- 239d96b: One canonical task key, `<initiative>/<TASK-ID>` (TP-5453 P5). `pm` exports `resolveTaskKey`, which turns a bare id, a prefixed key or a repo-qualified key into the canonical key, or refuses it as malformed, not found, ambiguous or wrong-initiative; an id two initiatives hold goes to the one whose `task_prefix` issued it. active-work's new `task.keys` command lists each initiative's `task_prefix`, `agent_visible` and the ids of its task files, open and archived, read from file names (MCP tool `active__task__keys`). `titan-factory shepherd register` stores the canonical key and exits 65 on a key that resolves to no one task. On an active-work daemon older than `task.keys` it resolves through `task.list` plus the archive file names; when no complete index can be read it refuses only a malformed key, stores the rest as given with a warning, and marks the run `taskVerified=false` in its params; build-surface resolves its spec's tasks before any agent is spawned under them. `titan-factory shepherd task-key-report` lists the registrations whose key is not canonical, with a proposed mapping or no match, through a read-only store connection.

## 0.9.0

### Minor Changes

- 5346139: Add the owner's planning ops (TP-5453 P3b): `plan-bet-select`, `plan-outcome-edit` and `plan-freeze-set` join the owner-queue op schema. The console offers each as an owner-op tap. Its read-back comes from the factory's `owner-op.preview`: each bet's outcome, prediction and tasks, an outcome's before and after, and what a freeze stops and when it ends. The factory gates the ops to owner-remote under HV-OR and applies them through pm's plan store under the initiative's plan lock. pm's `FreezeSchema` gains an optional `ended_on`. active-work's `plan freeze add` now records `set_by: decider` and refuses `--set-by owner`. No CLI, RPC or MCP verb selects a bet, edits an outcome or ends a freeze.

## 0.8.0

### Minor Changes

- fc303a7: Add the optional task fields `bet`, `fold` and `owner_steps` to `TaskSchema`, with `BetLookup` and `betProblem` for the write-time check that a task's bet exists. active-work's `task add` and `task edit` refuse a task naming a bet the lookup does not know (TP-5453 P2).
- d497596: Add a `./node` subpath to pm holding the planning-record file store (read, validated atomic write, the `<initiative>/plan/.lock`), so every plan writer shares one layout and one lock; the root entry stays pure. active-work's plan store is now a thin adapter over it, with no change in behaviour.

## 0.7.0

### Minor Changes

- 46ae5e5: Add the task provenance fields `class`, `serves`, `source`, `source_ref`, `filed_by`, `rank`, `done_reason`, `blocked_on` and `field_origin` to `TaskSchema`, all optional on read, and `TaskRequireSchema` for a brief's `task_require` list, which active-work's brief schema now reads (TP-5446 S7).

## 0.6.0

### Minor Changes

- feec10d: Add strict schemas for planning records: `OutcomeSchema`, `BetSchema` (with `PredictionSchema`), `FreezeSchema` (with `FreezeEndConditionSchema`) and `OutOfScopeSchema`, plus `OwnerIntentRefSchema` for owner-intent references (an intent id and a quote reference).

## 0.5.0

### Minor Changes

- ad90aec: Add an initiative-level `visibility` (`owner-only` | `agent-visible`) to the brief and one predicate, `isAgentVisible`, in `@titan-design/pm` (TP-5453 P6). A brief with no `visibility`, or one that will not parse, is owner-only; a dated transitional list keeps the named code initiatives visible until their briefs declare it.

  active-work: the workspace indexer stores only the initiative row of an owner-only initiative; `search`, the MCP search tool, `context.related`, the cross-initiative `context.graph` scan, `precedent search` and the bootstrap's foreign notes serve no owner-only initiative. `context.related` no longer reads the charter's `human_only_initiatives` and no longer reports a `charter` degradation. `set <slug> visibility <value>` is how the owner marks a brief, and it refuses an agent caller.

  evals: the task-initiative allow-list and private markers come from `isAgentVisible` instead of a hard-coded list.

## 0.4.0

### Minor Changes

- a67d654: Add review-folder parsers: `parseTopicsJudged` (the seven common columns, any others kept in `extra`), `parseClaimsAudit` (`basis`, `note` and `wave` optional), `readReviewPin` (case-insensitive `- key: value` README bullets), `sumRunCost` (headless spend from `runs.tsv`), the `TOPIC_PRIORITIES` and `TOPIC_VERDICTS` vocabularies, and export `readTsv`.

## 0.3.0

### Minor Changes

- d357882: Add the repo-review disposition gate: `summaryRecommendations` lists SUMMARY.md's recommendation bullets, `prioritizedTopics` lists a review's P1 and P2 topics, `parseDispositions` validates `dispositions.tsv` rows (task, dup, fold, drop or pending-owner), and `checkDispositions` matches rows to items by id and names each item with no row.

## 0.2.0

### Minor Changes

- 8030b8e: `TaskSchema` gains an optional `actual` block (agent hours, review hours, USD, service wall
  hours, peak context, context at first deliverable, `at`, `model`), an optional `claimedHours`
  list of `{ hours, by, at }`, and an optional `started_at` datetime. `created` and `done_at` now
  accept a full ISO-8601 datetime as well as `YYYY-MM-DD`. `isoDate` is unchanged.

## 0.1.0

### Minor Changes

- a96b022: New tier-2 package with the zod task schema (`TaskSchema`) and its inferred `Task` type, ported from active-work with the same fields, defaults and refinements. Pure code: no fs, process or network.
- f1ce2cd: Add `parent` (one task id) and `dep` (unique id list) to `TaskSchema`. Add `readEdges(task)`, which reads those fields and, during the migration window only, falls back to `epic:`/`parent:` and `dep:`/`blocked-by:` tags. Add `checkEdges(tasks, change)`, a pure check that returns `unknown-id` and `cycle` errors and a non-fatal `cross-initiative-parent` warning.
- a4814b3: Add the deliverable registry: `DeliverableSchema` (`id`, `title`, `done_when`, `target`, `status` of `planned`, `active`, `shipped` or `dropped`, `owner_seat`, retrieval-only `tags`, `created`, `updated` and `shipped_at`, which is set exactly when the status is `shipped`), `DELIVERABLE_ID_REGEX`, `DELIVERABLE_STATUSES`, `deliverablesDir(activeRoot)` for `<activeRoot>/titan-platform/deliverables`, `deliverablePath(activeRoot, id)`, and `parseDeliverableRegistry(entries)`, which validates the files the host read and treats no entries, a missing directory, as an empty registry. `TaskSchema` gains an optional `deliverables` list of unique deliverable ids.
- ef4358f: Add `taskTree(tasks, rootId)`, the subtree under a task by `parent` edges with each node's status and estimate, and `criticalPath(tasks, { deliverable })`, the total float of each open task over its `dep` edges and the longest open chain by estimate. A dep outside the set counts as satisfied, an unestimated task has duration 0, and dep cycles are reported rather than thrown. Until the category registry is wired in, `done` and `wont-do` count as closed.
- 597745d: Add `CategoryRegistrySchema` for the closed `kind`, `status`, `cos` and `area` axes (it must list status `open`, `done`, `wont-do` and `icebox` and kind `epic`), `categoriesPath(activeRoot)`, `parseCategoryRegistry`, which reads a missing file as a null registry, and the pure `checkCategories(task, registry)`, which returns `unknown-category` and `cos-fixed-without-due` errors. `TaskSchema` gains optional `kind`, `cos`, `area` and `due`, and `status` is now any non-empty string: a null registry checks it against `BUILT_IN_STATUSES` (`open`, `done`).
