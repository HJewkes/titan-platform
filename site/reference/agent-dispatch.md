# agent-dispatch

**Tier 1.** No titan dependencies.

```sh
npm install @titan-design/agent-dispatch
```

## The problem it solves

agent-chat has no library entry point that spawns an agent, and its broker serves no spawn
route over HTTP. The supported programmatic surface is the `agent-chat` CLI. Shelling out
to it safely has three traps: `PATH` is not what a launchd job expects, `process.env` leaks
into the child, and a brief passed in argv is readable by every local process through `ps`.

This package is the one client that handles all three. `dispatchToAgentChat` sends the
brief on stdin under `--brief-stdin`, so no brief text ever reaches argv, and first
refuses any profile whose installed file is not `"surface": "headless"`, because
agent-chat puts an interactive agent's brief in `claude`'s argv. `execSafe` runs
an absolute path with a minimal environment and no shell.

`spawnAsCaller` is the spawn for a command a human or an agent runs, not a daemon. It
forwards the caller's `AGENT_CHAT_NAME`, `AGENT_CHAT_AGENT_ID` and `CLAUDE_CONFIG_DIR` when
set, so the broker sees an agent's spawn as that agent's and a least-used account pick
prefers the caller's account on a tie. Nothing else from the caller's environment reaches
the child.

## When to reach for it

A product that must start an agent-chat agent under a named profile, or give an ended
agent's Claude Code session one more message, from code. Use `dispatchToAgentChat` from a
daemon, which spawns headless profiles as the human, and `spawnAsCaller` from a CLI command
that spawns on behalf of whoever runs it. To run one headless Claude turn
in-process with a typed result, use [agent](./agent.md) instead. To record which process
owns a running execution, use [agent-lifecycle](./agent-lifecycle.md).

## Example

Verified against 0.0.0.

```ts
import { BrokerUnavailableError, assertInstalledHeadless, dataFence, dispatchToAgentChat, execSafe, listAgents, messageAgent, minimalEnv, parkAgent, resolveBinaryPath, resumeAgent, resumeArgs, retire, spawnAsCaller } from "@titan-design/agent-dispatch";

const profiles = ["headless-implementer", "headless-reviewer"];

await dispatchToAgentChat(
  {
    agentChatBinPath: "/opt/homebrew/bin/agent-chat",
    peerName: "item-42",
    profile: "headless-implementer",
    brief: "Fix the squeaky floor",
    briefing: "my-initiative",
    cwd: "/path/to/repo",
  },
  15_000,
  profiles,
);
// { peerName: "item-42" } once the broker accepts the spawn

await spawnAsCaller(
  {
    agentChatBinPath: "/opt/homebrew/bin/agent-chat",
    name: "planner-1",
    profile: "coordinator",
    brief: "Plan the next slice",
    cwd: "/path/to/repo",
    account: "least-used", // also host, surface, remoteControl
  },
  15_000,
);
// { name: "planner-1", lines: ["account: ...", "Spawned planner-1 ..."] }

assertInstalledHeadless("headless-reviewer"); // throws DispatchError unless <agent-chat home>/profiles/headless-reviewer.json is headless

const ended = (await listAgents("/opt/homebrew/bin/agent-chat", 15_000)).filter((a) => a.presence === "exited");
await retire("/opt/homebrew/bin/agent-chat", "item-42", 15_000); // { name: "item-42", caveats: [] }
await parkAgent("/opt/homebrew/bin/agent-chat", "item-7", 60_000); // { name: "item-7", lines: ["Parked item-7.", ...] }
await messageAgent("/opt/homebrew/bin/agent-chat", "item-9", "CI is red; the log tail follows", 15_000); // a live agent's next turn

try {
  await resumeAgent("/opt/homebrew/bin/agent-chat", "item-42", dataFence("CI log", logTail), 15_000);
  // { name: "item-42", lines: ["Resumed item-42 on its existing conversation, ...", ...] }
} catch (err) {
  if (!(err instanceof BrokerUnavailableError)) throw err;
  // nothing reached the broker; retry later
}

const claude = resolveBinaryPath("/opt/homebrew/bin/claude", "claude");
const turn = execSafe(claude, resumeArgs(sessionId, "CI is red; see the log"), minimalEnv(), 600_000, worktree);
```

## Limits

The `./limits` subpath holds the spend limits a budget gate reads, as data rather than
charter prose or constants. One versioned block keys pools by name, one per Claude account,
and adds per-profile, per-seat and time-boxed layers:

```ts
import { checkLimits, liftQuestion, resolveLimits } from "@titan-design/agent-dispatch/limits";
import { loadLimits, readGrants } from "@titan-design/agent-dispatch/limits/node";

const parsed = loadLimits("/path/to/host-config.json", { key: "limits" });
const { grants } = readGrants("/path/to/limits-grants.json");
const result = resolveLimits(parsed, {
  pool: "agents",
  profile: "bd-implementer",
  now: new Date(),
  grants,
  answeredQuestions: new Set(ownerAnswerIds),
  fiveHourResetsAt: reading.resetsAt,
});
if (!result.open) refuse(result.reason); // a malformed or unknown pool fails closed
// result.limits: { ceiling_five_hour: 95, reserve_seven_day: 14, sonnet_band_points: 0, ...,
//   sources: { ceiling_five_hour: "pool", ... }, applied: ["override:<decision>"] }

checkLimits(parsed, { now: new Date() }); // [{ kind: "expired_override", message: "..." }, ...]
```

Each field resolves independently, the later layer winning: `LIMIT_DEFAULTS`, then
`defaults`, the pool, the profile on every pool, the profile × pool entry, active
`overrides[]` (later entry wins; `null` per-day lifts the cap), and answered grants. Then
the ceiling is clamped to 0-100, the reserve to 0-100 and every margin to 0 or more.

- An override carries an `until`. Past it the override stops applying and `checkLimits`
  reports it, so a standing value comes back with no edit.
- A malformed pool closes that pool, a malformed profile closes spawns of that profile, a
  malformed seat closes that seat, and a malformed override or grant is ignored. Only a bad
  envelope (wrong `version`, not an object) throws `LimitsConfigError`.
- Seat caps are a separate stop: `per_run_points` is added and `per_day_points` only ever
  lowers the pool's.
- `liftQuestion` asks once per pool per five-hour window when a pool with a `lift` reaches
  its ceiling. `grantFromAnswer` turns a yes into a grant until that window resets. The
  resolver accepts a grant only if its question id is in `answeredQuestions`, it ends by
  `fiveHourResetsAt`, and it clamps the grant to the pool's `lift`.

## Routing

The `./routing` subpath holds the workflow table that picks an implementer profile from a
task's facts: estimate, done_when, tags and the files its plan owns. The package ships the
default table as `workflow/shape-v1.yml`.

```ts
import { classifyTask, parseWorkflowTable, profileFor } from "@titan-design/agent-dispatch/routing";
import { DEFAULT_WORKFLOW_TABLE } from "@titan-design/agent-dispatch/routing/node";

const { table } = parseWorkflowTable(readFileSync(DEFAULT_WORKFLOW_TABLE, "utf8"));
const facts = { estimate: 2, done_when: "ships", tags: [], owns: ["src/cli/x.ts"] };
const { prior, reason } = classifyTask(table!, facts); // "standard", "estimate 2 <= 2"
profileFor(table!, prior, facts.estimate); // "bd-implementer-lite"
```

Rules run in order and the first match wins, so a risk row (door, safety or visual paths,
`kind:security`) beats a size row. A row with `needsOwns: true` never matches a task whose
owns are unknown, so missing facts route up to `needs-plan`, never down.

At spawn time, `routeSpawn` turns the table's pick into the profile that runs:

```ts
import { routeMeta, routeSpawn } from "@titan-design/agent-dispatch/routing";

const decision = routeSpawn({
  mode: "shadow", // "off" | "shadow" | "on"
  requested: "implementer", // or "auto"
  table: { table: table!, id: "shape-v1@1a2b3c4d" },
  taskId: "EX-1",
  role: "fix-round-2", // kept, logged as keep-role
  facts,
});
// undefined for a reviewer, or for an explicit profile with routing off
const meta = decision === undefined ? {} : routeMeta(decision); // { route_source: "keep-role", ... }
```

| `source` | When | Profile that runs |
|---|---|---|
| `auto` | `auto` was requested | the table's tier, else `bd-implementer` |
| `routed` | `on`, and the table picks another tier | the table's tier, in the caller's family |
| `agrees` | the table picks the requested tier, or a profile outside the tiers | requested |
| `shadow` | `shadow`, and the table picks another tier | requested |
| `override` | the caller passed an override | requested |
| `keep-role` | the role is a keep-role (default `fix-round`) | requested |
| `no-task` | `auto` with no task id | `bd-implementer` |
| `table-error` | the table could not be read | requested, or `bd-implementer` for `auto` |

A `candidate` table is classified beside the live one, and its pick is recorded as
`candidateWanted` but never applied. `summarizeRoutes(rows)` reads logged rows back. It
counts agreement over `agrees`, `shadow` and `routed` only, so keep-role, override and auto
rows are not in the denominator.

The `./routing/node` subpath supplies a spawn path with the table and the facts:

```ts
import { readRouteTable, readSpawnFacts } from "@titan-design/agent-dispatch/routing/node";

const read = readRouteTable("/path/to/shape-v1.yml"); // cached on mtime and size
const { facts, note } = readSpawnFacts("/path/to/active-work", "EX-7", "b", req.owns ?? []);
const decision = routeSpawn({
  mode,
  requested,
  taskId: "EX-7",
  table: read.table,
  tableProblem: read.problem,
  facts,
  factsNote: note,
});
```

`readSpawnFacts` never throws. An unknown id, or one that is not a plain file name, gives
empty facts with source `none`, and the router keeps the requested profile.

## Isolation

The `./isolation` subpath holds the isolation strategies a spawn picks from its profile and
the rules that keep a retire or a park from pulling a worktree out from under another agent.
The host builds the worktree strategy, because it reads host budgets, and hands it in:

```ts
import {
  createIsolationRegistry,
  refusalsIn,
  worktreeTenancy,
} from "@titan-design/agent-dispatch/isolation";

const registry = createIsolationRegistry({ worktree: hostWorktreeStrategy });
const strategy = registry.resolve(["toolset-limited", "worktree"]);
const reasons = await strategy.check(ctx);
if (refusalsIn(reasons).length > 0) throw new Error(reasons.join("; "));
const allocation = await strategy.allocate(ctx);

const verdict = worktreeTenancy(
  { agentId: "a1", name: "scout", isolation: "worktree", ref: allocation.ref },
  notRetiredRoster,
  false,
);
// { refusal: "scout allocated the worktree ..., and heir (not retired) is working in it. ..." }
```

- `none`, `toolset-limited` and `file-ownership` are pure. `check` lines carrying
  `WARNING_PREFIX` are advisory; `refusalsIn` keeps the rest.
- `worktreeTenancy`, `adopterBlocker` and `parkTenancyBlocker` are the one CC-141 rule for the
  single retire, the bulk retire and the park. Paths are compared after `canonicalPath`, so a
  symlinked cwd still counts.
- `allocatedWorktree`, `parkBlocker`, `parkable` and `liveBlocker` are the park rules over
  journal rows and roster identities.

## What it deliberately does not do

It holds no profile names, derives no peer names and installs no profile files: those are
product policy, so the allowlist is an argument. The limits subpath owns no file path, reads
no usage, writes no grant and posts no question: the product passes paths, readings and
owner answers in. It does not wait for the agent's work,
decide whether an agent is live before a resume, or talk to the broker's socket directly.

## Gotchas

- A zero exit from `dispatchToAgentChat` means "started", not "done".
- `dispatchToAgentChat` reads `<profile>.json` from `$AGENT_CHAT_HOME/profiles` (else
  `$HOME/.agent-chat/profiles`) before the spawn (or `profilesDir` when given) and refuses
  one that is missing or not headless.
  Tests that spawn through a fake binary must install that file. The broker re-reads the
  profile afterwards, so a write in between still reaches it until agent-chat's surface
  lock lands.
- `spawnAsCaller` checks no profile allowlist and no headless surface: the broker gates
  the spawn as it would the caller's own CLI call. It fails the way `dispatchToAgentChat`
  does. An agent-chat too old to know `--account`, `--host` or `--remote-control` fails
  with its usage error as the message.
- A spawn that hangs throws `DispatchTimeoutError`, not plain `DispatchError`: the broker
  may already have started the agent, so read the roster before re-dispatching.
- A failed spawn throws `DispatchError` with the CLI's stdout reason (broker refusals,
  including a name held by a live agent) or else its stderr (usage errors, such as an
  agent-chat too old to know `--brief-stdin`).
- `execSafe` returns a non-zero exit instead of throwing. It throws `ExecTimeoutError` on a
  timeout, because a timed-out child may already have acted, and `ExecError` when the
  binary cannot start.
- `listAgents` needs an agent-chat with `agent ls --json`; an older one fails with its
  usage error. A row missing a required field is skipped, not guessed at; an optional
  field with the wrong type is dropped from its row.
- `retire` throws `DispatchTimeoutError` (a `DispatchError`) when the CLI hangs: the broker
  may already have retired the agent, so read the roster before retrying.
- `parkAgent` requires a timeout (`DEFAULT_PARK_TIMEOUT_MS` is 60 s). Only Shepherd passes
  `{ noFixRoundCheck: true }`, which needs an agent-chat that knows `--no-fix-round-check`.
- `parkAgent` throws `DispatchError` when the broker refuses a live, dirty, unpushed or
  shared tree. A broker that predates the verb (CC-282) times out on the CLI side and comes
  back as a refusal naming a broker restart.
- `BrokerUnavailableError` is raised only for agent-chat's own unreachable-broker lines on
  stderr ("could not reach or start the agent-chat broker", a restart's "was NOT sent", or a
  bare `connect ECONNREFUSED|ENOENT <socket>`). A refusal that quotes that text elsewhere
  stays a plain `DispatchError`.
- Calls set `AGENT_CHAT_NO_AUTOSTART=1`. An agent-chat that does not honour it yet still
  starts a broker when none is running.
- `resumeAgent` puts the message in argv, where `ps` shows it. Fence untrusted text with
  `dataFence` and keep secrets out of it.
- `messageAgent` reaches a live agent only, and the broker delivers the text from the human
  seat. A `{ source }` option labels it as that wake source instead of the owner's words. For
  an ended agent use `resumeAgent`. The text is in argv.
- `resumeArgs` puts the message in argv. Resuming a live agent starts a second process on
  the same transcript; check liveness first.

## Where it came from

Ported unchanged from relay's `daemon/src/dispatch.ts`, `exec.ts` and the `resumeArgs`
builder in `session.ts` (TP-460), with their tests. relay's daemon now depends on the
package and its copy is deleted; relay keeps only its profile policy
in `agent-profiles.ts`. `listAgents` and `retire` were added afterwards for Shepherd, then `resumeAgent`,
`configDir`, `BrokerUnavailableError` and `dataFence` (ported from agent-chat's burndown
brief) by TP-518, `parkAgent` by TP-548, `messageAgent` by TP-728, and
`assertInstalledHeadless` (ported from relay's `daemon/src/profile-guard.ts`, PR #59) by
TP-470, and `spawnAsCaller` by TP-4215. The `./limits`
subpath (TP-2067) replaces the `pools:` and `funds:` blocks of a coordinator charter.
