/**
 * R-61: hand a claimed item to agent-chat's own agent machinery instead of
 * spawning Claude ourselves.
 *
 * ## Why this shells out instead of importing
 *
 * agent-chat exposes exactly one subpath (`./spawn-kernel`), and that file
 * states the rule this module has to live with: "Nothing that spawns.
 * `run-agent.ts` in particular must never be exported from here — it builds
 * `env: { ...process.env }`, which is precisely what relay's own threat model
 * (T7/M8) forbids." There is no library equivalent of the `agent_spawn` MCP
 * tool, and the broker serves no spawn route over HTTP. The supported
 * programmatic surface is the CLI, which forwards a `{t:'spawn'}` frame over
 * the broker's 0600 unix socket.
 *
 * So: `execSafe` against an absolute `agent-chat` path, argv array, minimal
 * env, exactly like `initiative.ts` already shells out to `active-work`.
 *
 * ## M8, and why the brief is not in argv (R-68)
 *
 * M8 (sources/agent-runner-threat-model.md) says nothing from an item body ever
 * reaches argv, and it closes T7 STRUCTURALLY. R-61 briefly downgraded that to
 * "practically safe": agent-chat's CLI took the brief as variadic argv, so a
 * body was world-readable via `ps` to any local process — a disclosure surface,
 * never an injection one, since `execFileSync` with `shell: false` and an argv
 * ARRAY never lets body content become a token another program parses.
 *
 * R-68 restored the structural version rather than leaving it a practice. The
 * brief goes to the child on stdin under `--brief-stdin`, added to agent-chat's
 * CLI following R-59's resume primitive; `buildSpawnArgs` returns an argv
 * carrying no item BODY, and `execSafe`'s `input` carries it instead. The
 * remaining hops were already clean: the CLI sends the brief to the broker over
 * a 0600 unix socket, and `launch-plan.ts` gives a HEADLESS agent its brief on
 * stdin rather than in `claude`'s argv.
 *
 * Two things that are deliberately NOT claimed here, because a reviewer found
 * both overstated on 2026-08-10:
 *
 * - Headless is the profile DEFAULT, not an enforced invariant. The check below
 *   validates the profile NAME; `launch-plan.ts` still argv's the brief on its
 *   interactive branch, which a runtime surface change could reach (R-71).
 * - The initiative SLUG still travels in argv behind `--briefing`. It derives
 *   from an item tag, so it is item-derived text — bounded to a strict slug by
 *   `initiative.ts` before it gets here, but not nothing.
 *
 * This makes the daemon require an agent-chat new enough to know the flag. An
 * older one exits non-zero on the unknown option, which surfaces as a dispatch
 * refusal rather than a silent spawn with a missing brief.
 *
 * ## Privilege note
 *
 * The CLI reaches the broker as the HUMAN, and `supervisor.ts` exempts the
 * human from BOTH `checkSpawnCwd`'s location policy and the spawn-rate budget.
 * Those two controls do not apply to anything this module starts; the daemon's
 * own single-flight loop (`loop.ts`) is what bounds spawn volume instead.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ExecError, execSafe, minimalEnv, resolveBinaryPath } from "./exec.js";

export class DispatchError extends Error {}

/**
 * The profile name asked of agent-chat. NOT the builtin `implementer`, which
 * this otherwise mirrors: builtins default to a VISIBLE `iterm-pane` surface so
 * a permission prompt lands somewhere a human can answer it, and a launchd
 * daemon has no guaranteed GUI session to open a pane into. The `surface` field
 * exists on the spawn wire protocol but the CLI exposes no flag for it, and
 * profiles resolve BY NAME ONLY — so selecting a headless variant means naming
 * a profile file, which is what `daemon/profiles/relay-implementer.json` is.
 *
 * That file must be installed to `~/.agent-chat/profiles/` for dispatch to
 * work at all; `agent-chat` refuses an unknown profile name and this module
 * surfaces that refusal verbatim rather than falling back to a builtin. A
 * silent fallback would be a fallback onto DIFFERENT tool grants, which is the
 * one thing a profile name is supposed to pin down.
 */
export const DISPATCH_PROFILE = "relay-implementer";

/**
 * The reviewer R-63 auto-spawns once a dispatched implementer finishes. Named
 * here beside `DISPATCH_PROFILE` because both are installed together and both
 * are refused by agent-chat if `cli.ts install` has not run — see
 * `installProfiles`.
 */
export const REVIEW_PROFILE = "relay-reviewer";

/** Same shape agent-chat's own registry enforces, checked before we spend a spawn. */
const PEER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PROFILE_FILES = [DISPATCH_PROFILE, REVIEW_PROFILE].map(
  (name) => `${name}.json`,
);

/**
 * Copy the profiles agent-chat has to be able to resolve by name into the only
 * directory it looks in.
 *
 * Run from `cli.ts install`, beside the launchd plist, because the daemon is
 * NON-FUNCTIONAL without them: an unknown profile name means agent-chat refuses
 * every spawn, so an install that skipped this would poll happily and refuse
 * every item it ever claimed. Copied rather than symlinked so a `git checkout`
 * in this worktree cannot silently change the tool grants of an already-running
 * daemon; re-run `install` to pick up an edit, which is the same contract the
 * plist already has.
 */
export function installProfiles(
  destDir: string = join(homedir(), ".agent-chat", "profiles"),
): string[] {
  const sourceDir = join(
    dirname(dirname(fileURLToPath(import.meta.url))),
    "profiles",
  );
  mkdirSync(destDir, { recursive: true });
  return PROFILE_FILES.map((file) => {
    const dest = join(destDir, file);
    copyFileSync(join(sourceDir, file), dest);
    return dest;
  });
}

export interface DispatchRequest {
  agentChatBinPath: string;
  /** `relay-item-<id>`; unique per item, so a re-dispatch collides on purpose. */
  peerName: string;
  /** `DISPATCH_PROFILE` or `REVIEW_PROFILE`; never anything an item could name. */
  profile: string;
  brief: string;
  /**
   * active-work slug, handed to agent-chat so ITS briefing auto-load runs.
   * Omitted for the reviewer, whose orientation is the worktree it lands in.
   */
  briefing?: string;
  /** The directory the CLI sends to the broker as the spawn location. */
  cwd: string;
}

export interface DispatchResult {
  peerName: string;
}

/**
 * The peer name is derived, never taken from item content — an item that could
 * choose its own name could impersonate another agent on the bus.
 */
export function peerNameFor(itemId: number): string {
  return `relay-item-${itemId}`;
}

/**
 * Built as an array and returned rather than run, so a test can assert the
 * exact argv without starting anything — the same seam R-59's `resumeWithMessage`
 * uses on agent-chat's side.
 *
 * The brief is deliberately ABSENT from what this returns. It travels on the
 * child's stdin under `--brief-stdin` instead (R-68), because argv is
 * world-readable via `ps` and the brief is an item body relay did not author.
 * That makes "no item text in argv" a property this function's return value
 * demonstrates on its own, rather than one that depends on how carefully the
 * caller quotes — which is the whole difference between a structural guarantee
 * and a practice.
 */
export function buildSpawnArgs(req: {
  peerName: string;
  profile: string;
  briefing?: string;
}): string[] {
  return [
    "agent",
    "spawn",
    req.peerName,
    req.profile,
    ...(req.briefing === undefined ? [] : ["--briefing", req.briefing]),
    "--brief-stdin",
  ];
}

/**
 * Start the agent and return the name it was started under.
 *
 * Fire-and-forget by construction: the CLI exits as soon as the broker has
 * accepted the spawn, so a zero exit means "the agent was started", NOT "the
 * work is done". That is why `executor.ts` reports a non-terminal
 * `run_progress` rather than a terminal event — the run stays open for R-62 to
 * close from agent-chat's own event stream.
 */
export function dispatchToAgentChat(
  req: DispatchRequest,
  timeoutMs: number,
): DispatchResult {
  if (!PEER_NAME_PATTERN.test(req.peerName)) {
    throw new DispatchError(`invalid peer name: '${req.peerName}'`);
  }
  // The profile name IS the tool grant. Two callers pass it now (R-63 added the
  // reviewer), so it is checked against the closed set rather than trusted to
  // be a constant — a profile chosen anywhere further from this line is a
  // different set of Write/Edit/Bash permissions chosen there too.
  if (req.profile !== DISPATCH_PROFILE && req.profile !== REVIEW_PROFILE) {
    throw new DispatchError(`unknown profile: '${req.profile}'`);
  }

  // Resolution is INSIDE the try: a missing or non-executable `agent-chat`
  // throws `ExecError` too, and letting that escape would crash `loop.ts`'s
  // tick with the item still claimed and nothing reported — the exact
  // orphaned-claim outcome P4's durable-refusal rule exists to prevent.
  let result;
  try {
    const bin = resolveBinaryPath(req.agentChatBinPath, "agent-chat");
    result = execSafe(
      bin,
      buildSpawnArgs(req),
      minimalEnv(),
      timeoutMs,
      req.cwd,
      req.brief,
    );
  } catch (err) {
    if (err instanceof ExecError) throw new DispatchError(err.message);
    throw err;
  }

  if (result.status !== 0) {
    // The CLI splits its failures across both streams, so both are read. A
    // BROKER refusal prints on stdout — including the name collision ("the name
    // X is held by a live agent; retire it or choose another"), the expected
    // outcome of re-dispatching an item whose previous agent has not retired.
    // A USAGE error goes through `fail()` on stderr, and that is the one an
    // agent-chat too old to know `--brief-stdin` produces; reading only stdout
    // reported it as an unexplained "exited 1".
    //
    // Reported verbatim either way: relay cannot resolve it, and inventing a
    // friendlier message would hide which of the supervisor's several preflight
    // gates actually refused.
    const reason = result.stdout.trim() || result.stderr.trim();
    throw new DispatchError(
      reason === ""
        ? `agent-chat agent spawn exited ${result.status}`
        : `agent-chat refused the spawn: ${reason}`,
    );
  }

  return { peerName: req.peerName };
}
