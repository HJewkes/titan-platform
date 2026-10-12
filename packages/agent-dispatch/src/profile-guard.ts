/**
 * Refuse a dispatch unless the profile agent-chat is about to load says
 * `"surface": "headless"` (relay R-71 slice A, ported from relay PR #59).
 *
 * agent-chat re-reads `<name>.json` from its profiles dir (`$AGENT_CHAT_HOME/profiles`,
 * default `~/.agent-chat/profiles`) on every spawn, and
 * a dispatched implementer holds `Write` and blanket `Bash`, neither
 * path-limited. So one agent can rewrite the installed profile to an
 * interactive surface, and the NEXT dispatch then puts its brief in `claude`'s
 * argv (agent-chat `launch-plan.ts`, interactive branch), where `ps` can read
 * it. That breaks M8.
 *
 * This reads the same file just before the spawn and fails closed on anything
 * but an explicit headless surface. A write between this read and the broker's
 * own read is still possible; the agent-chat surface lock (R-71 slice C)
 * closes that window.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DispatchError } from "./dispatch.js";

/**
 * agent-chat's own rule: `$AGENT_CHAT_HOME/profiles`, else
 * `$HOME/.agent-chat/profiles`. `||` rather than `??` so an empty variable
 * falls back instead of yielding a relative `profiles`. Resolved per call so
 * it tracks both variables. Read from `process.env` first because `homedir()`
 * sees the process-wide variable, not a worker thread's own env.
 */
export function installedProfilesDir(): string {
  const agentChatHome =
    process.env.AGENT_CHAT_HOME || join(process.env.HOME || homedir(), ".agent-chat");
  return join(agentChatHome, "profiles");
}

/** Checked before the name reaches a path join, so `../x` never touches the filesystem. */
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const REINSTALL_HINT = "reinstall it with `agent-chat profiles install`";

function readInstalledProfile(profile: string, dir: string): unknown {
  const path = join(dir, `${profile}.json`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new DispatchError(
      `installed profile '${profile}' is unreadable at ${path} (${err instanceof Error ? err.message : String(err)}); ${REINSTALL_HINT}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DispatchError(
      `installed profile '${profile}' at ${path} is not valid JSON; ${REINSTALL_HINT}`,
    );
  }
}

/** Names the surface's type rather than its value, so a refusal never echoes the file's contents. */
function describeSurface(surface: unknown): string {
  if (surface === undefined) return "missing";
  if (typeof surface === "string" && /^[a-z-]{1,32}$/.test(surface)) {
    return `"${surface}"`;
  }
  return `of type ${surface === null ? "null" : typeof surface}`;
}

export function assertInstalledHeadless(
  profile: string,
  dir: string = installedProfilesDir(),
): void {
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    throw new DispatchError(`invalid profile name: '${profile}'`);
  }
  const parsed = readInstalledProfile(profile, dir);
  const surface =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { surface?: unknown }).surface
      : undefined;
  if (surface !== "headless") {
    throw new DispatchError(
      `installed profile '${profile}' at ${join(dir, `${profile}.json`)} has surface ${describeSurface(surface)}, not "headless"; refusing to dispatch because an interactive surface puts the brief in argv; ${REINSTALL_HINT}`,
    );
  }
}
