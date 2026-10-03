import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CloseOutcome, LaunchHandle, LaunchPlan, Surface, SurfaceName } from "../types.js";
import { paneCommand, relaunchCommand, type Launcher } from "./command.js";
import { psProbe, watchLaunch, type LaunchMarker, type PaneReader } from "./launch-check.js";
import { SurfaceRefused, type AppleScriptRunner, type SurfaceOptions } from "./options.js";

/**
 * The iTerm2 surfaces, and two lessons that must survive:
 *
 * 1. Target the anchor session by the UUID inside `ITERM_SESSION_ID`, iterating
 *    windows/tabs/sessions to find it. NEVER `current window`: that follows user
 *    focus, so panes land in whichever window is frontmost when the script runs,
 *    which is rarely the one the human was looking at when they asked.
 * 2. Do not title anything here. iTerm's `set name` does not stick (the running
 *    job overwrites it); the launcher emits an OSC 0 escape instead.
 */

export type ItermSurfaceName = Extract<SurfaceName, `iterm-${string}`>;

/** Returned by the search scripts when the anchor session no longer exists. */
const NO_ANCHOR = "@@no-anchor@@";

/** Returned by the teardown script when it found the session and closed it. */
const CLOSED = "@@closed@@";

/** Returned by the existence probe. Two sentinels, so a throw can never read as "gone". */
const PRESENT = "@@present@@";
const GONE = "@@gone@@";

/** Kill-line in zsh and bash, for a prompt that already holds stray keys. */
const CTRL_U = 21;

const execFileAsync = promisify(execFile);

/** Past this, an Automation prompt or a wedged iTerm2 is not going to answer. */
export const OSASCRIPT_TIMEOUT_MS = 10_000;

const osascript: AppleScriptRunner = async script =>
  (
    await execFileAsync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: OSASCRIPT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    })
  ).stdout.trim();

const asString = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** `ITERM_SESSION_ID` is `w0t1p2:UUID`; only the UUID identifies a session. */
const anchorUuid = (anchor: string | undefined): string | undefined => {
  const uuid = anchor?.slice(anchor.lastIndexOf(":") + 1).trim();
  return uuid === undefined || uuid === "" ? undefined : uuid;
};

/**
 * One pass for both sessions we might target. `columnUuid` is empty when there is
 * no column yet, and no session's unique ID is ever the empty string, so the
 * lookup simply finds nothing, which is also the correct answer when the column
 * pane existed and has since been closed.
 */
const findSessions = (uuid: string, columnUuid: string): string => `
  set anchorSession to missing value
  set anchorWindow to missing value
  set columnSession to missing value
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is ${asString(uuid)} then
          set anchorSession to s
          set anchorWindow to w
        end if
        if (unique ID of s) is ${asString(columnUuid)} then
          set columnSession to s
        end if
      end repeat
    end repeat
  end repeat
  if anchorSession is missing value then return ${asString(NO_ANCHOR)}`;

/**
 * Where the human's keystrokes were going, read before a surface opens and put
 * back after it. Read only, never used to place anything.
 *
 * `create tab` makes its window key and `create window` activates iTerm2, so
 * without this the next keystroke lands in the agent's pane. `select` on a
 * window is `makeKeyAndOrderFront`, which does not activate iTerm2 when some
 * other app is in front.
 */
const rememberFocus = `  set priorWindow to missing value
  try
    set priorWindow to current window
  end try`;

const restoreFocus = `  if priorWindow is not missing value then
    try
      select priorWindow
    end try
  end if`;

/**
 * Agents stack in a column beside the anchor, rather than each one splitting the
 * anchor again, which halved the requester's pane on every spawn. The first agent
 * splits the anchor VERTICALLY; each later agent splits the previous AGENT pane
 * HORIZONTALLY, so the column subdivides and the anchor keeps its width.
 *
 * Falling back to the vertical split when the column session is gone is what
 * makes a closed agent pane self-healing: the next spawn starts a fresh column.
 * There is no depth parameter: the anchor is always the requester's own pane, so
 * an agent's own spawns land one column further right for free.
 *
 * The anchor window's tab and session are re-selected afterwards because a
 * split selects the anchor's tab and a new tab selects itself.
 */
const beside = (surface: ItermSurfaceName, uuid: string, command: string, columnUuid: string = ""): string => {
  const withCommand = `with default profile command ${asString(command)}`;
  const open =
    surface === "iterm-pane"
      ? `  if columnSession is not missing value then
    tell columnSession to set spawned to (split horizontally ${withCommand})
  else
    tell anchorSession to set spawned to (split vertically ${withCommand})
  end if`
      : `  tell anchorWindow to set spawned to (current session of (create tab ${withCommand}))`;
  return `tell application "iTerm2"${findSessions(uuid, columnUuid)}
${rememberFocus}
  set anchorTab to current tab of anchorWindow
  set anchorWindowSession to current session of anchorWindow
${open}
  select anchorTab
  select anchorWindowSession
${restoreFocus}
  return unique ID of spawned
end tell`;
};

/**
 * Run the command IN the anchor session, rather than opening anything.
 *
 * Only for a successor taking a predecessor's own pane: the predecessor has
 * already exited, so its shell is back at a prompt, and the successor lands
 * exactly where the session it continues was sitting.
 *
 * An existing shell cannot be given a command at creation, so this one is still
 * typed. It is one write, Ctrl-U and then the short relaunch path, so no gap is
 * left between clearing the line and filling it; see `relaunchCommand` for what
 * catches keys that still land in front of it or after it.
 */
const inPlace = (uuid: string, command: string): string => `tell application "iTerm2"${findSessions(uuid, "")}
  tell anchorSession to write text ((character id ${CTRL_U}) & ${asString(command)})
  return unique ID of anchorSession
end tell`;

/** The fallback everything lands on: needs no anchor, so it cannot fail to find one. */
const newWindow = (command: string): string => `tell application "iTerm2"
${rememberFocus}
  set spawned to (current session of (create window with default profile command ${asString(command)}))
${restoreFocus}
  return unique ID of spawned
end tell`;

/**
 * Close one session, found the same way everything else here finds one.
 *
 * A session is the unit for all three surfaces: closing the last session of a
 * tab closes the tab, and the last tab of a window closes the window. Finding
 * nothing is the ordinary case of a human who already closed it by hand.
 */
const closeSession = (uuid: string): string => `tell application "iTerm2"${findSessions(uuid, "")}
  tell anchorSession to close
  return ${asString(CLOSED)}
end tell`;

/**
 * Does iTerm2 still list this session? Re-read rather than inferred:
 * `closeSession` returning `@@closed@@` only says the script found the session
 * and issued `close`, not that the close took.
 */
const sessionPresent = (uuid: string): string => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is ${asString(uuid)} then return ${asString(PRESENT)}
      end repeat
    end repeat
  end repeat
  return ${asString(GONE)}
end tell`;

/**
 * Whether iTerm2 still holds `uuid`, for callers outside a teardown.
 *
 * Unknown (undefined) is a third answer and not a synonym for either: iTerm2 not
 * running, a non-Mac, or osascript failing all mean this cannot say.
 */
export async function itermSessionPresent(
  uuid: string,
  options: SurfaceOptions = {},
): Promise<boolean | undefined> {
  const run = options.runAppleScript ?? osascript;
  try {
    await requireIterm(options, run);
    return await probeSession(run, uuid);
  } catch {
    return undefined;
  }
}

/** The probe without the `requireIterm` round trip, for a caller that just made one. */
async function probeSession(run: AppleScriptRunner, uuid: string): Promise<boolean | undefined> {
  try {
    const answer = await run(sessionPresent(uuid));
    return answer === PRESENT ? true : answer === GONE ? false : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asked without launching it: `is running` is false for an app that is not up,
 * where a `tell` would start iTerm2 and drop a window on an unsuspecting desktop.
 */
const itermRunning = async (run: AppleScriptRunner): Promise<boolean> => {
  try {
    return (await run('application "iTerm2" is running')) === "true";
  } catch {
    return false;
  }
};

async function requireIterm(options: SurfaceOptions, run: AppleScriptRunner): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin")
    throw new SurfaceRefused(`iTerm2 surfaces need macOS (this is ${platform}); use surface 'headless'`);
  if (!(await itermRunning(run))) throw new SurfaceRefused("iTerm2 is not running; use surface 'headless'");
}

/** One field of one session, or `@@gone@@` when iTerm2 no longer lists it. */
const sessionField = (uuid: string, field: "tty" | "contents"): string => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is ${asString(uuid)} then return ${field} of s
      end repeat
    end repeat
  end repeat
  return ${asString(GONE)}
end tell`;

const paneReader = (run: AppleScriptRunner, uuid: string): PaneReader => ({
  tty: async () => {
    const tty = await run(sessionField(uuid, "tty"));
    return tty === GONE ? undefined : tty;
  },
  contents: async () => {
    const contents = await run(sessionField(uuid, "contents"));
    return contents === GONE ? "" : contents;
  },
});

const launchMarker = (launcher: Launcher, agentId: string): LaunchMarker => {
  const argv = launcher.argv(agentId);
  return [argv.at(-2) ?? "", argv.at(-1) ?? ""];
};

interface ItermLaunch {
  surface: ItermSurfaceName;
  plan: LaunchPlan;
  launcher: Launcher;
  options: SurfaceOptions;
  run: AppleScriptRunner;
}

/** A pane with the check that the launcher started in it: one this launch opened, or a reused one. */
const watched = (handle: LaunchHandle & { paneRef: string }, launch: ItermLaunch): LaunchHandle => ({
  ...handle,
  launchFailed: watchLaunch(
    paneReader(launch.run, handle.paneRef),
    launch.options.probeProcesses ?? psProbe,
    launchMarker(launch.launcher, launch.plan.agentId),
    launch.options.launchCheck,
  ),
});

/** Reuse falls through to the ordinary ladder when the pane has closed, so the agent still lands somewhere findable. */
async function reuse(launch: ItermLaunch, uuid: string): Promise<LaunchHandle | undefined> {
  const { surface, plan, launcher, options, run } = launch;
  // No `ownsSurface`: this pane was already open and this launch only wrote into it.
  const paneRef = await run(inPlace(uuid, relaunchCommand(launcher, plan.agentId)));
  if (paneRef !== NO_ANCHOR) return watched({ surface, paneRef }, launch);
  options.onNotice?.(`pane ${uuid} is gone; opening an iTerm window rather than reusing it`);
  return undefined;
}

/**
 * The ladder, in order: no anchor -> a window; anchor recorded but gone -> a
 * window plus a notice; no iTerm2 at all -> refuse, naming headless.
 */
async function launchIterm(launch: ItermLaunch): Promise<LaunchHandle> {
  const { surface, plan, launcher, options, run } = launch;
  await requireIterm(options, run);
  const uuid = anchorUuid(options.anchor);
  const command = paneCommand(launcher, plan.agentId);
  const opened = (at: ItermSurfaceName, paneRef: string): LaunchHandle =>
    watched({ surface: at, paneRef, ownsSurface: true }, launch);

  if (options.reuseAnchor && uuid !== undefined) {
    const reused = await reuse(launch, uuid);
    if (reused !== undefined) return reused;
  } else if (surface !== "iterm-window" && uuid !== undefined) {
    const paneRef = await run(beside(surface, uuid, command, options.columnAfter));
    if (paneRef !== NO_ANCHOR) return opened(surface, paneRef);
    options.onNotice?.(`anchor session ${uuid} is gone; opening an iTerm window instead of ${surface}`);
  }
  return opened("iterm-window", await run(newWindow(command)));
}

/**
 * Close what this launch opened, and nothing else, then go and check.
 *
 * Every failure here is benign and none of them should fail a shutdown: iTerm2
 * has quit, the human closed the pane themselves, osascript is unavailable. What
 * is NOT acceptable is reporting it closed when it is not, so each of those
 * outcomes arrives with the sentence that explains it.
 */
async function closeIterm(handle: LaunchHandle, options: SurfaceOptions): Promise<CloseOutcome> {
  if (handle.ownsSurface !== true)
    return { closed: false, reason: "the host did not open this surface, so it is not ours to close" };
  if (handle.paneRef === undefined) return { closed: false, reason: "no pane was recorded for this agent" };

  const run = options.runAppleScript ?? osascript;
  const paneRef = handle.paneRef;
  try {
    await requireIterm(options, run);
    const answer = await run(closeSession(paneRef));
    if (answer !== CLOSED) return { closed: false, reason: `iTerm2 no longer lists session ${paneRef}` };
    // `@@closed@@` says the script ran, not that the pane went; only the second look decides.
    const present = await probeSession(run, paneRef);
    if (present === true) return { closed: false, reason: `iTerm2 still lists session ${paneRef} after closing it` };
    if (present === undefined)
      return { closed: false, reason: `could not re-read iTerm2 to confirm session ${paneRef} is gone` };
    return { closed: true };
  } catch (err) {
    return { closed: false, reason: `iTerm2 could not be reached: ${(err as Error).message}` };
  }
}

export function itermSurface(name: ItermSurfaceName, launcher: Launcher, options: SurfaceOptions = {}): Surface {
  return {
    name,
    interactive: true,
    launch: (plan: LaunchPlan): Promise<LaunchHandle> =>
      launchIterm({ surface: name, plan, launcher, options, run: options.runAppleScript ?? osascript }),
    close: (handle: LaunchHandle): Promise<CloseOutcome> => closeIterm(handle, options),
  };
}
