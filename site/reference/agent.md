# agent

**Tier 1 · engines.** No titan dependencies. Depends on `@anthropic-ai/claude-agent-sdk`;
`zod` v4 is a peer.

```sh
npm install @titan-design/agent zod
```

::: info Example not executed here
Every other package page on this site shows output from a run. This one cannot: calling
`runAgent` starts a real Claude Code session and spends real budget. The example below is
the package's own documented usage and its types are checked by the build, but the output
comments describe the contract rather than a captured run.
:::

## The problem it solves

Triggering a headless Claude Code session is one SDK call. Doing it in production means
adding three things every caller ends up adding by hand: a **scrubbed child environment**,
**mandatory circuit breakers**, and a **failure taxonomy you can branch on**.

`runAgent` is that wrapper. It never throws for anything the agent does; the only throws are
caller mistakes caught before the session starts.

## When to reach for it

You are triggering agents from a tool — a workflow step, a queue worker, a scheduled job —
and you need a typed answer or a typed failure rather than a stream to babysit. For
retrying, scheduling, or pooling those runs, use [`workflow`](/reference/workflow); this
package runs exactly one session.

## Example

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

## Budgets are required, not defaulted

The SDK leaves `maxTurns` and `maxBudgetUsd` unlimited. Rather than pick a default nobody
would notice was wrong, both are **required fields**, and `runAgent` throws a `TypeError`
before it calls `query()` if either is missing, zero, negative, or not finite.

## The environment scrub

`prepareEnv(env, { allowApiKeyBilling })` copies the environment and hands the result to
`options.env`. It never mutates its argument and never reads `process.env` except as the
default first argument.

| Variable | Action | Why |
| --- | --- | --- |
| `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT` | strip | a child CLI that inherits these refuses to start inside a parent session |
| every other `CLAUDE_CODE_*` | strip | describes the parent session and confuses the child's config inference |
| `CLAUDE_CODE_OAUTH_TOKEN` | keep | the subscription credential |
| `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` | keep | a deliberate provider choice |
| `CLAUDE_CODE_MAX_RETRIES` | keep, default `3` | the built-in default of 10 turns an outage into a long silent hang |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | strip unless `allowApiKeyBilling` | either one silently outranks the OAuth token and bills the API account |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (both cases) | strip | leak from the parent shell and re-route the child's API traffic |
| everything else | keep | ordinary process environment |

Two guards sit either side of the run. `assertAuthEnvOk` is the pre-flight: it refuses to
start when the OAuth token is missing, or when a metered credential survived the scrub. The
post-flight reads `apiKeySource` off the first `system/init` message and ends the run as
`auth_misconfigured` if it names the env API-key path.

That post-flight check is a **blacklist, not a whitelist**: the SDK's `ApiKeySource` union
grows over time, and an unknown new member is far more likely to be another benign route
than a billing one.

## Failures

One `kind` per recovery strategy, so a caller can branch instead of parsing a message.

| kind | Means |
| --- | --- |
| `rate_limited` | usage or burst limit; carries `retryAt` when the stream or the message said when |
| `budget_exceeded` | `maxBudgetUsd` was reached |
| `max_turns` | `maxTurns` was reached |
| `schema_invalid` | the SDK exhausted its structured-output retries, or the answer failed your zod schema |
| `refusal` | the model declined |
| `auth_misconfigured` | the pre-flight or the `apiKeySource` check failed |
| `runtime_error` | anything else, including a dead subprocess |
| `aborted` | the caller's `AbortSignal` fired |
| `inactivity_timeout` | no message arrived for `inactivityTimeoutMs` (default 600,000) |

`classifyResult(resultMessage, options?)` is exported, so a product can map a result message
it captured itself.

## Gotchas

**`result.usage` holds the SDK's client-side estimates**, priced from a bundled table. Use
them as a budget signal, never as a billing statement. The SDK's cost fields are already
cumulative across a `query()` call, so this package reads the latest result rather than
summing; `modelUsage` is the fallback when a crash result arrives with the total zeroed.

**A subagent inherits `bypassPermissions`, `acceptEdits` and `auto` from the parent** and
cannot narrow them per-subagent. A parent running wide open gives every subagent that same
reach regardless of what its `AgentDefinition` says. Prefer `allowedTools` wildcards over a
permissive mode.

**Two defaults are chosen for headless safety.** `permissionMode` defaults to `"dontAsk"`,
so nothing runs that was not pre-approved. `settingSources` defaults to `[]`, so no
CLAUDE.md, settings file, or `.mcp.json` is picked up off the filesystem unless you ask.

**Every run ends cleanly.** The inactivity watchdog resets on each streamed message and, like
the caller's `AbortSignal`, ends the run through the SDK's `abortController` and then
`query.close()`, so no CLI subprocess is left behind.

## Where it came from

brain's `agent-submission` spike (925 tested lines), rather than its PM-tangled production
path.
