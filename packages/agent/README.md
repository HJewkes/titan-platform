# @titan-design/agent

Run one headless Claude Code session and get back either a typed answer or a
typed failure. A thin wrapper over the Claude Agent SDK's `query()` that adds the
three things a production caller always has to add itself: a scrubbed child
environment, mandatory circuit breakers, and a failure taxonomy you can branch on.

Tier 1 of the titan-platform DAG (TP-11). Depends on
`@anthropic-ai/claude-agent-sdk`; `zod` is a peer (v4).

## Run an agent

```ts
import { z } from "zod";
import { runAgent } from "@titan-design/agent";

const result = await runAgent({
  prompt: "Summarise the failing tests in this repo.",
  cwd: "/path/to/worktree",
  maxTurns: 12,
  maxBudgetUsd: 2,
  outputSchema: z.object({ failing: z.array(z.string()), likelyCause: z.string() }),
});

if (result.ok) {
  console.log(result.output.likelyCause, result.usage.totalCostUsd);
} else if (result.failure.kind === "rate_limited") {
  scheduleRetry(result.failure.retryAt);
}
```

`runAgent` never throws for anything the agent does. The only throws are caller
mistakes caught before the session starts: a missing or non-positive budget.

## Budgets are required, not defaulted

The SDK leaves `maxTurns` and `maxBudgetUsd` unlimited. Rather than pick a
default nobody would notice was wrong, both are required fields on
`AgentRunConfig` and `runAgent` throws a `TypeError` before it calls `query()`
if either is missing, zero, negative, or not finite.

## The environment scrub

`prepareEnv(env, { allowApiKeyBilling })` copies the environment and hands the
result to `options.env`. It never mutates its argument and never reads
`process.env` except as the default first argument.

| Variable | Action | Why |
|---|---|---|
| `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT` | strip | a child CLI that inherits these refuses to start inside a parent session |
| every other `CLAUDE_CODE_*` (e.g. `CLAUDE_CODE_EXECPATH`) | strip | describes the parent session and confuses the child's config inference |
| `CLAUDE_CODE_OAUTH_TOKEN` | keep | the subscription credential |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` | keep | a deliberate provider choice |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | keep | a deliberate opt-out |
| `CLAUDE_CODE_MAX_RETRIES` | keep, default `3` | the built-in default of 10 turns an outage into a long silent hang |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | strip unless `allowApiKeyBilling` | either one silently outranks the OAuth token and bills the API account |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (both cases) | strip | leak from the parent shell and re-route the child's API traffic |
| everything else | keep | ordinary process environment |

Two guards sit either side of the run. `assertAuthEnvOk` is the pre-flight: it
refuses to start when the OAuth token is missing, or when a metered credential
survived the scrub. The post-flight reads `apiKeySource` off the first
`system/init` message and ends the run as `auth_misconfigured` if it names the
env API-key path. That check is a **blacklist**, not a whitelist: the SDK's
`ApiKeySource` union grows over time, and an unknown new member is far more
likely to be another benign route than a billing one.

## Failures

One `kind` per recovery strategy:

| kind | Means |
|---|---|
| `rate_limited` | usage or burst limit; carries `retryAt` when the stream or the message said when |
| `budget_exceeded` | `maxBudgetUsd` was reached |
| `max_turns` | `maxTurns` was reached |
| `schema_invalid` | the SDK exhausted its structured-output retries, or the answer failed the caller's zod schema |
| `refusal` | the model declined |
| `auth_misconfigured` | the pre-flight or the `apiKeySource` check failed |
| `runtime_error` | anything else, including a dead subprocess |
| `aborted` | the caller's `AbortSignal` fired |
| `inactivity_timeout` | no message arrived for `inactivityTimeoutMs` (default 600 000) |

`classifyResult(resultMessage, options?)` is exported so a product can map a
result message it captured itself.

## Structured output

Pass `outputSchema` and the SDK is asked for `outputFormat: { type: "json_schema" }`.
The SDK validates and retries on its own; this package re-parses
`structured_output` with the same zod schema so the value you receive is the one
TypeScript promises. `result.output` is the final assistant text when no schema
was given.

## Cost

`result.usage` is `{ totalCostUsd, modelUsage, turns, durationMs }`. These are
the SDK's **client-side estimates**, priced from a bundled table. Use them as a
budget signal, never as a billing statement. The SDK's cost fields are already
cumulative across a `query()` call, so this package reads the latest result
rather than summing; `modelUsage` is the fallback when a crash result arrives
with the total zeroed.

## Subagents and permissions

`agents`, `mcpServers`, `hooks`, `allowedTools`, `disallowedTools`, `model`,
`resumeSessionId` and `settingSources` pass straight through. Two defaults are
chosen for headless safety:

- `permissionMode` defaults to `"dontAsk"`, so nothing runs that was not
  pre-approved.
- `settingSources` defaults to `[]`, so no CLAUDE.md, settings file, or
  `.mcp.json` is picked up off the filesystem unless you ask for it.

**Gotcha:** a subagent *inherits* `bypassPermissions`, `acceptEdits` and `auto`
from the parent and cannot narrow them per-subagent. A parent running wide open
gives every subagent that same reach regardless of what its `AgentDefinition`
says. Prefer `allowedTools` wildcards over a permissive mode.

This package runs one session. It does not pool, schedule, or retry; that
belongs to the workflow tier.

## Explicit multi-harness contracts

`dispatchHarnessRun(request, adapter)` is the new, explicit contract for Claude
Code and Codex adapters. It does not replace or reroute `runAgent()`. Every request
has a discriminating `harness`, a fresh or resume target, and a required positive
finite `wallTimeMs`. Claude's Anthropic SDK fields live only under the
`claude-code` branch; Codex model, reasoning, sandbox, approval, and native JSON
Schema fields live only under the `codex` branch.

Optional limits name their unit (`usd`, `model_requests`, `agent_iterations`, or
`tokens`), scope (`execution` or `conversation`), and enforcement (`hard` or
`advisory`). These are not interchangeable: an agent iteration is not a model
request, and an estimated SDK dollar stop is not a hard financial cap.

Adapters supply a `HarnessCapabilityDescriptor` that marks every operation and
declared limit `supported`, `unsupported`, or `unverified`, with evidence or a
reason. Core declares no adapter capabilities itself. Before invoking an adapter,
the dispatcher checks the operation, resume identity, structured-output and
cancellation needs, caller requirements, mandatory hard execution deadline, and
all optional limits. Unsupported and unverified requirements return an
`unsupported_requirement` result with no adapter call.

Support for the hard `milliseconds` execution limit means the adapter can stop
the local execution at its deadline. It does not claim that a remote model request
has stopped unless the adapter separately reports verified cancellation support.
Normalized progress, results, usage measurements, execution identity, conversation
identity, and transcript source hints contain no harness-native event types.

## Supervised Codex exec adapter

`createCodexExecAdapter({ auth: "cached-cli" })` runs the pinned ChatGPT desktop
Codex binary through `codex exec --json`. The caller must select a model and an
absolute working directory. Fresh runs persist a native thread; resumes always use
the supplied native thread ID and never `--last`. The adapter ignores user config,
strips API-key credentials from the child environment, accepts only the
noninteractive `never` approval policy, and leaves persistence enabled so
`@titan-design/session-read` can discover the rollout by thread ID and namespace.

The adapter checks `codex --version` before every launch. The mandatory wall deadline
covers that check, temporary output-schema setup, and the run itself. Timeout or
caller abort terminates the owned process group, then sends `SIGKILL` after the
configured grace period. JSONL output becomes normalized progress, conversation
identity, final text or locally validated structured output, and token usage with
Codex event provenance. Hard dollar, request, iteration, and token caps remain
unsupported and fail preflight before either version probing or process spawn.

A zero exit is successful only after Codex emits `turn.completed`. Its usage is a
turn snapshot: the adapter uses Codex's native turn ID when one is present and an
execution-correlated synthetic turn ID otherwise. It is never labeled as a
conversation total. If an abort or wall deadline stops the OS process without a
native terminal turn event, the result is `cancelled_unknown` and retains the
requested cause and process exit evidence. Temporary schema cleanup completes
before the terminal progress event, so cleanup failure cannot follow a reported
successful finish.

## Ending a run

Every run ends cleanly. The inactivity watchdog resets on each streamed message
and, like the caller's `AbortSignal`, ends the run through the SDK's
`abortController` and then `query.close()`, so no CLI subprocess is left behind.
