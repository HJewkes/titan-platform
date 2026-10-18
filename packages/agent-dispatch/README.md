# @titan-design/agent-dispatch

A client for agent-chat's supported programmatic surface, the `agent-chat` CLI. It starts
an agent under a named profile with the brief on stdin (never in argv, which `ps` shows to
every local process), builds the argv that resumes an ended agent's Claude Code session
with one more message, and runs binaries by absolute path with a minimal environment.

Tier 1 of the titan-platform DAG, with no titan dependencies (zod is a peer dependency,
used by `readAnswers` and the `./limits` subpath). Ported unchanged from relay's
`daemon/src/dispatch.ts`, `exec.ts` and `session.ts` (`resumeArgs`) by TP-460. relay's
daemon now depends on this package and its own copy is deleted.

```ts
import { dispatchToAgentChat, resumeArgs, execSafe, minimalEnv } from "@titan-design/agent-dispatch";

await dispatchToAgentChat(
  { agentChatBinPath: "/opt/homebrew/bin/agent-chat", peerName: "item-42", profile: "headless-implementer", brief, cwd },
  15_000,
  ["headless-implementer", "headless-reviewer"],
);
```

- `dispatchToAgentChat(req, timeoutMs, allowedProfiles)` refuses a profile outside the
  caller's allowlist and a peer name outside agent-chat's name shape, then refuses a
  profile whose installed file is not headless (`assertInstalledHeadless`), then runs
  `agent-chat agent spawn <name> <profile> [--briefing <slug>] --brief-stdin`. A zero exit
  means the broker accepted the spawn, not that the work is done. A non-zero exit rejects
  with `DispatchError` carrying the CLI's stdout reason, else its stderr; a CLI that hangs
  rejects with `DispatchTimeoutError`, since the spawn may still have happened. So does a
  stderr line `broker did not answer <frame>_result` (the broker missed its reply window,
  and the frame may have landed), on this and every other verb here. It runs the
  CLI in `req.cwd`, which agent-chat sends to the broker as the spawn location.
- `assertInstalledHeadless(profile, dir?)` reads `<dir>/<profile>.json` (default
  `installedProfilesDir()`: `$AGENT_CHAT_HOME/profiles`, else `$HOME/.agent-chat/profiles`)
  and throws `DispatchError` unless it says `"surface": "headless"`: an interactive surface
  puts the brief in `claude`'s argv. A missing, unreadable or non-JSON file is refused too,
  and so is a profile name outside `^[a-z0-9][a-z0-9._-]*$`, before any path is built. The refusal names the profile and
  path, never the file's contents. `dispatchToAgentChat` takes `profilesDir` to point it
  elsewhere. The broker re-reads the file after this check, so a write in between is still
  possible until agent-chat's surface lock closes that window.
- `agentChatEnv()` is the env every agent-chat CLI call runs under. It forwards a non-empty
  `AGENT_CHAT_HOME`, so the CLI reaches the broker whose profiles the guard read.
- `dispatchToAgentChat` also takes `configDir`, passed as `--config-dir <path>` to run the
  agent on another Claude account.
- `dispatchToAgentChat` and `resumeAgent` take an opt-in `launchedBy: "shepherd"` (and an
  optional `launchReason`), sent as `--launched-by shepherd [--launch-reason <text>]` so the
  agent's roster row records who started it. It is a record, not the `--spawned-as` gate
  input. A caller that leaves it out sends the same argv as before.
- `resumeAgent(bin, name, message, timeoutMs, launch?)` runs `agent-chat agent resume <name>
  --message <message>`, so the broker tracks the resumed session. It refuses a name outside
  agent-chat's name shape before running anything, and rejects with `DispatchError` on the
  broker's refusal. The message is in argv.
- `parkAgent(bin, name, timeoutMs?)` runs `agent-chat agent park <name>`: the broker removes
  an exited agent's clean, pushed worktree and keeps its branch, and `resumeAgent`
  re-creates it. A refusal (live, dirty, unpushed or shared tree) rejects with `DispatchError`
  carrying the broker's reason; a broker that cannot be reached rejects with
  `BrokerUnavailableError`. It is async: `agent park` may read the caller back (agent-chat asks
  Shepherd about a fix round), so a caller that serves HTTP must keep its event loop free.
- `messageAgent(bin, name, text, timeoutMs)` runs `agent-chat debug send -- <name> <text>`:
  the broker delivers the text to a live agent as one channel message from the human seat,
  which starts a turn in an idle session. A name with no live session rejects with
  `DispatchError` carrying the broker's reason. The text is in argv.
- `dataFence(label, text)` wraps untrusted text in a fence one backtick longer than the
  longest backtick run in it (at least three), preceded by a line saying it is data.
- Every agent-chat call runs with `AGENT_CHAT_NO_AUTOSTART=1`. When the CLI reports that it
  cannot reach the broker, the call rejects with `BrokerUnavailableError` (a
  `DispatchError`); every other refusal stays a plain `DispatchError`. Every verb that runs
  the CLI is async, so a caller that serves HTTP keeps its event loop free while a slow
  child answers.
- `resumeArgs(sessionId, message)` returns `claude` argv; run it with `execSafe`. The
  message is in argv here, so callers decide what may go in it.
- `listAgents(bin, timeoutMs)` reads `agent-chat agent ls --json` and returns typed
  `AgentRow`s, skipping a row whose required field is missing or mistyped and dropping an
  optional field (`model`, `transcriptPath`, `transcriptExists`, `spawnedBy`, `account`,
  `teleportFrom`) that has the wrong type. `retire(bin, name,
  timeoutMs, { force })` frees a name and returns the broker's caveats. Both reject with
  `DispatchError`, or `DispatchTimeoutError` when the CLI hangs, since a hung retire may
  still have happened.
- `askHuman(bin, { as, text, task?, options?, recommended? }, timeoutMs)` puts a question on
  agent-chat's human queue for a process that is not a Claude session, under the service
  label `as`, and returns its msg_id. It runs `agent-chat ask --as <label> --text-stdin
  --json`, with the text on stdin. `readAnswers(bin, label, since, timeoutMs)` reads the
  answers and dismissals to that label's asks after the msg_id `since`, oldest first, as
  `{ answers: ServiceAnswer[], next? }`; pass `next` back as `since`. A body that is not
  that shape throws rather than reading as an empty page. `dismissAsk(bin, msgId,
  timeoutMs)` withdraws an ask, and throws `DispatchError` when it is already closed. All
  three throw `BrokerUnavailableError` when the broker is down or predates the verbs (exit
  69), and a `DispatchError` naming a usage error on exit 2.
- `execSafe`, `execSafeAsync`, `minimalEnv` and `resolveBinaryPath` never use `PATH` lookup
  or `process.env`, and never a shell. `execSafeAsync(bin, args, env, timeoutMs, input?,
  cwd?)` is the non-blocking form; `input` and `cwd` are opt-in.
- `observeAgentChatCalls(report, { now? })` reports `{ verb, ms, outcome }` for every
  agent-chat call this package makes, spawn included, and returns the unsubscribe. The verb
  is `agent <sub>` or the first argv word, so no peer name or briefing is ever reported.
  `outcome` is `ok`, `refused` (non-zero exit), `timeout` or `error`. An observer that
  throws is ignored, and nothing is timed while no observer is registered.

Profile names, peer-name derivation and profile installation are the caller's policy and
are not in this package.

## Limits (`./limits`, `./limits/node`)

The per-pool and per-profile spend limits the budget gate reads: one versioned `limits`
block with `defaults`, `pools`, `funds`, `profiles`, `seats` and time-boxed `overrides`.

- `limitsSchema` validates a whole block; `parseLimits(raw)` splits it by scope so a
  malformed pool, profile or seat closes only itself and a malformed override is ignored.
  An unusable envelope throws `LimitsConfigError`.
- `resolveLimits(parsed, { pool, profile?, seat?, now, grants?, answeredQuestions?,
  fiveHourResetsAt? })` folds code defaults, `defaults`, the pool, the profile, the
  profile × pool entry, active overrides and answered grants, field by field, then clamps.
  It returns the source layer of every field. A seat cap only tightens.
- `checkLimits(parsed, { now, knownConfigDirs?, knownProfiles? })` reports expired
  overrides, closed scopes, unknown pools, profiles and config dirs, and clamps.
- `liftQuestion` and `grantFromAnswer` are the pure halves of the owner's time-boxed lift.
- `loadLimits(path, { key? })` and `readGrants(path)` from `./limits/node` read files the
  caller names; the package owns no path.
