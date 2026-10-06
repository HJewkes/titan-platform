import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CloseOutcome, LaunchHandle, LaunchPlan, Surface } from "../types.js";
import { launchCommand, type Launcher } from "./command.js";
import { SurfaceRefused, type SurfaceOptions } from "./options.js";

/** The persistent session a factory host's seats live in, unless options name another. */
export const TMUX_SESSION = "fac";

/** tmux answers a local socket at once; past this the server is wedged. */
export const TMUX_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

/** Killing a session's last window can take the whole server with it, which is still "gone". */
const NO_SERVER = /no server running|error connecting to/;

const socketArgs = (options: SurfaceOptions): string[] =>
  options.tmuxSocket === undefined ? [] : ["-L", options.tmuxSocket];

/** Runs tmux with an argv, never a shell, and resolves with its trimmed stdout. */
async function tmux(options: SurfaceOptions, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tmux", [...socketArgs(options), ...args], {
      encoding: "utf8",
      timeout: TMUX_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return stdout.trim();
  } catch (err) {
    const failed = err as { code?: unknown; stderr?: unknown; message: string };
    if (failed.code === "ENOENT") throw new SurfaceRefused("tmux is not installed; use surface 'headless'");
    const said = typeof failed.stderr === "string" ? failed.stderr.trim() : "";
    throw new Error(said === "" ? failed.message : said);
  }
}

/**
 * tmux expands a window name as a format, where `#(...)` runs a shell command.
 * Doubling every `#` makes the name literal.
 */
export const tmuxLiteral = (text: string): string => text.replaceAll("#", "##");

async function hasSession(options: SurfaceOptions, session: string): Promise<boolean> {
  try {
    await tmux(options, ["has-session", "-t", `=${session}`]);
    return true;
  } catch (err) {
    if (err instanceof SurfaceRefused) throw err;
    return false;
  }
}

/**
 * A detached window in the session, running the fixed launcher line through the
 * tmux server's shell. No `remain-on-exit`, so the window closes when the agent
 * exits. A missing session is started rather than refused, so the agent still
 * lands somewhere `tmux attach` finds.
 */
async function launchTmux(plan: LaunchPlan, launcher: Launcher, options: SurfaceOptions): Promise<LaunchHandle> {
  const session = options.tmuxSession ?? TMUX_SESSION;
  const command = launchCommand(launcher, plan.agentId);
  const name = tmuxLiteral(plan.title === "" ? plan.agentId : plan.title);
  const detached = ["-d", "-P", "-F", "#{window_id}", "-n", name];
  const exists = await hasSession(options, session);
  if (!exists) options.onNotice?.(`tmux session '${session}' did not exist; starting it`);
  const args = exists
    ? ["new-window", ...detached, "-t", `=${session}:`, command]
    : ["new-session", ...detached, "-s", session, command];
  return { surface: "tmux-window", paneRef: await tmux(options, args), ownsSurface: true };
}

/**
 * Whether the tmux server still holds window `windowId` (`@N`, unique per
 * server), for a host inferring that an agent exited. Unknown (undefined) means
 * this cannot say, and is a synonym for neither answer.
 */
export async function tmuxWindowPresent(windowId: string, options: SurfaceOptions = {}): Promise<boolean | undefined> {
  try {
    const ids = await tmux(options, ["list-windows", "-a", "-F", "#{window_id}"]);
    return ids.split("\n").includes(windowId);
  } catch (err) {
    return err instanceof Error && NO_SERVER.test(err.message) ? false : undefined;
  }
}

/** Kill what this launch opened, and nothing else, then go and check, as the iTerm close does. */
async function closeTmux(handle: LaunchHandle, options: SurfaceOptions): Promise<CloseOutcome> {
  if (handle.ownsSurface !== true)
    return { closed: false, reason: "the host did not open this surface, so it is not ours to close" };
  if (handle.paneRef === undefined) return { closed: false, reason: "no window was recorded for this agent" };

  const windowId = handle.paneRef;
  try {
    await tmux(options, ["kill-window", "-t", windowId]);
  } catch (err) {
    return { closed: false, reason: `tmux could not kill window ${windowId}: ${(err as Error).message}` };
  }
  const present = await tmuxWindowPresent(windowId, options);
  if (present === true) return { closed: false, reason: `tmux still lists window ${windowId} after killing it` };
  if (present === undefined) return { closed: false, reason: `could not re-read tmux to confirm window ${windowId} is gone` };
  return { closed: true };
}

/**
 * A seat in a window of a persistent tmux session, for a host with no iTerm2.
 * Resume is an ordinary launch: the old window closed with its agent, so a new
 * one opens.
 */
export function tmuxSurface(launcher: Launcher, options: SurfaceOptions = {}): Surface {
  return {
    name: "tmux-window",
    interactive: true,
    launch: (plan: LaunchPlan): Promise<LaunchHandle> => launchTmux(plan, launcher, options),
    close: (handle: LaunchHandle): Promise<CloseOutcome> => closeTmux(handle, options),
  };
}
