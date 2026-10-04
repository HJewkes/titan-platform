import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CloseOutcome, LaunchHandle, LaunchPlan, Surface } from "../types.js";
import { paneCommand, relaunchCommand, type Launcher } from "./command.js";
import {
  CLOSED,
  GONE,
  NO_ANCHOR,
  NO_WINDOW,
  OVERFLOWED,
  PRESENT,
  beside,
  closeSession,
  inPlace,
  newWindow,
  sessionField,
  sessionPresent,
  tabIn,
  type ItermSurfaceName,
} from "./iterm-scripts.js";
import { psProbe, watchLaunch, type LaunchMarker, type PaneReader } from "./launch-check.js";
import { SurfaceRefused, type AppleScriptRunner, type SurfaceOptions } from "./options.js";

export type { ItermSurfaceName };

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

/** `ITERM_SESSION_ID` is `w0t1p2:UUID`; only the UUID identifies a session. */
const anchorUuid = (anchor: string | undefined): string | undefined => {
  const uuid = anchor?.slice(anchor.lastIndexOf(":") + 1).trim();
  return uuid === undefined || uuid === "" ? undefined : uuid;
};

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

/** A cap that is not a positive whole number is no cap, rather than a script that cannot compile. */
const tabCap = (cap: number | undefined): number | undefined =>
  cap !== undefined && Number.isInteger(cap) && cap > 0 ? cap : undefined;

/** `uuid|inTab|overflow`; a bare uuid is still an answer, with nothing known about the tab. */
const parsePlacement = (answer: string): { paneRef: string; inTab: number | undefined; overflowed: boolean } => {
  const [paneRef = "", count = "", flag] = answer.split("|");
  const inTab = Number.parseInt(count, 10);
  return { paneRef, inTab: Number.isNaN(inTab) ? undefined : inTab, overflowed: flag === OVERFLOWED };
};

/** A rung of the ladder: the handle it opened, or the name of the target that is gone. */
type Rung = () => Promise<LaunchHandle | string>;

async function besideAnchor(launch: ItermLaunch, uuid: string, command: string): Promise<LaunchHandle | string> {
  const { surface, options, run } = launch;
  const cap = tabCap(options.maxInTab);
  const { columnAfter: columnUuid, split } = options;
  const answer = await run(beside({ surface, uuid, command, columnUuid, split, cap }));
  if (answer === NO_ANCHOR) return `anchor session ${uuid}`;
  const { paneRef, inTab, overflowed } = parsePlacement(answer);
  if (overflowed)
    options.onNotice?.(`the anchor's tab holds ${inTab} sessions (cap ${cap}); opening an iTerm tab instead of ${surface}`);
  const at = overflowed ? "iterm-tab" : surface;
  return watched({ surface: at, paneRef, ownsSurface: true, ...(inTab === undefined ? {} : { inTab }) }, launch);
}

async function tabInWindow(launch: ItermLaunch, windowId: string, command: string): Promise<LaunchHandle | string> {
  const paneRef = await launch.run(tabIn(windowId, command));
  if (paneRef === NO_WINDOW) return `window ${windowId}`;
  return watched({ surface: "iterm-tab", paneRef, ownsSurface: true }, launch);
}

/** A tab with a named window goes there and nowhere else; a pane tries its anchor first. */
const rungs = (launch: ItermLaunch, uuid: string | undefined, command: string): Rung[] => {
  const { surface, options } = launch;
  const windowId = options.tabWindow === undefined ? undefined : String(options.tabWindow);
  const viaAnchor = uuid === undefined ? [] : [() => besideAnchor(launch, uuid, command)];
  const viaWindow = windowId === undefined ? [] : [() => tabInWindow(launch, windowId, command)];
  return surface === "iterm-tab" && viaWindow.length > 0 ? viaWindow : [...viaAnchor, ...viaWindow];
};

/** Walks the rungs, and says so once when the agent lands somewhere other than where it was asked. */
async function place(launch: ItermLaunch, uuid: string | undefined, command: string): Promise<LaunchHandle | undefined> {
  const { surface, options } = launch;
  const gone: string[] = [];
  let handle: LaunchHandle | undefined;
  for (const rung of rungs(launch, uuid, command)) {
    const result = await rung();
    if (typeof result !== "string") {
      handle = result;
      break;
    }
    gone.push(result);
  }
  if (gone.length > 0) {
    const where = handle === undefined ? "an iTerm window" : `an iTerm tab in window ${options.tabWindow}`;
    options.onNotice?.(`${gone.join(" and ")} ${gone.length > 1 ? "are" : "is"} gone; opening ${where} instead of ${surface}`);
  }
  return handle;
}

/**
 * The ladder, in order: the anchor or the named window -> there; neither given ->
 * a window; given but gone -> a window plus a notice; no iTerm2 at all ->
 * refuse, naming headless.
 */
async function launchIterm(launch: ItermLaunch): Promise<LaunchHandle> {
  const { surface, plan, launcher, options, run } = launch;
  await requireIterm(options, run);
  const uuid = anchorUuid(options.anchor);
  const command = paneCommand(launcher, plan.agentId);

  if (options.reuseAnchor && uuid !== undefined) {
    const reused = await reuse(launch, uuid);
    if (reused !== undefined) return reused;
  } else if (surface !== "iterm-window") {
    const placed = await place(launch, uuid, command);
    if (placed !== undefined) return placed;
  }
  return watched({ surface: "iterm-window", paneRef: await run(newWindow(command)), ownsSurface: true }, launch);
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
