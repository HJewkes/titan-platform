import type { SurfaceName } from "../types.js";
import type { SurfaceOptions } from "./options.js";

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
export const NO_ANCHOR = "@@no-anchor@@";

/** Returned by the tab-in-window script when no window has the id it was given. */
export const NO_WINDOW = "@@no-window@@";

/** The third field of a placement answer when a full tab turned a pane into a tab. */
export const OVERFLOWED = "overflow";

/** Returned by the teardown script when it found the session and closed it. */
export const CLOSED = "@@closed@@";

/** Returned by the existence probe. Two sentinels, so a throw can never read as "gone". */
export const PRESENT = "@@present@@";
export const GONE = "@@gone@@";

/** Kill-line in zsh and bash, for a prompt that already holds stray keys. */
const CTRL_U = 21;

const asString = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * One pass for both sessions we might target. `columnUuid` is empty when there is
 * no column yet, and no session's unique ID is ever the empty string, so the
 * lookup simply finds nothing, which is also the correct answer when the column
 * pane existed and has since been closed.
 *
 * `inTab` is counted here, while the anchor's tab is in hand, because a second
 * osascript round trip per spawn is what the load data argues against.
 */
const findSessions = (uuid: string, columnUuid: string): string => `
  set anchorSession to missing value
  set anchorWindow to missing value
  set columnSession to missing value
  set inTab to 0
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is ${asString(uuid)} then
          set anchorSession to s
          set anchorWindow to w
          set inTab to (count of sessions of t)
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
 * `split: 'below'` starts the stack under the anchor rather than beside it; a
 * live column is extended downwards either way. A tab at `cap` sessions takes
 * no more splits: the agent opens as a tab in the anchor's window instead.
 *
 * The anchor window's tab and session are re-selected afterwards because a
 * split selects the anchor's tab and a new tab selects itself.
 */
interface Beside {
  surface: ItermSurfaceName;
  uuid: string;
  command: string;
  columnUuid: string | undefined;
  split: SurfaceOptions["split"];
  cap: number | undefined;
}

export const beside = ({ surface, uuid, command, columnUuid, split, cap }: Beside): string => {
  const withCommand = `with default profile command ${asString(command)}`;
  const tab = `tell anchorWindow to set spawned to (current session of (create tab ${withCommand}))`;
  const pane = `if columnSession is not missing value then
    tell columnSession to set spawned to (split horizontally ${withCommand})
  else
    tell anchorSession to set spawned to (split ${split === "below" ? "horizontally" : "vertically"} ${withCommand})
  end if`;
  const capped = `if inTab >= ${cap} then
    ${tab}
    set overflow to ${asString(OVERFLOWED)}
  else
    ${pane.replaceAll("\n", "\n  ")}
  end if`;
  const open = surface !== "iterm-pane" ? tab : cap === undefined ? pane : capped;
  return `tell application "iTerm2"${findSessions(uuid, columnUuid ?? "")}
${rememberFocus}
  set anchorTab to current tab of anchorWindow
  set anchorWindowSession to current session of anchorWindow
  set overflow to ""
  ${open}
  select anchorTab
  select anchorWindowSession
${restoreFocus}
  return (unique ID of spawned) & "|" & inTab & "|" & overflow
end tell`;
};

/**
 * A tab in a window named by id, for a requester with no session to anchor on.
 * The window's own tab is re-selected because a new tab selects itself.
 */
export const tabIn = (windowId: string, command: string): string => `tell application "iTerm2"
  set homeWindow to missing value
  repeat with w in windows
    if ((id of w) as text) is ${asString(windowId)} then set homeWindow to w
  end repeat
  if homeWindow is missing value then return ${asString(NO_WINDOW)}
${rememberFocus}
  set homeTab to current tab of homeWindow
  tell homeWindow to set spawned to (current session of (create tab with default profile command ${asString(command)}))
  select homeTab
${restoreFocus}
  return unique ID of spawned
end tell`;

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
export const inPlace = (uuid: string, command: string): string => `tell application "iTerm2"${findSessions(uuid, "")}
  tell anchorSession to write text ((character id ${CTRL_U}) & ${asString(command)})
  return unique ID of anchorSession
end tell`;

/** The fallback everything lands on: needs no anchor, so it cannot fail to find one. */
export const newWindow = (command: string): string => `tell application "iTerm2"
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
export const closeSession = (uuid: string): string => `tell application "iTerm2"${findSessions(uuid, "")}
  tell anchorSession to close
  return ${asString(CLOSED)}
end tell`;

/**
 * Does iTerm2 still list this session? Re-read rather than inferred:
 * `closeSession` returning `@@closed@@` only says the script found the session
 * and issued `close`, not that the close took.
 */
export const sessionPresent = (uuid: string): string => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is ${asString(uuid)} then return ${asString(PRESENT)}
      end repeat
    end repeat
  end repeat
  return ${asString(GONE)}
end tell`;

/** One field of one session, or `@@gone@@` when iTerm2 no longer lists it. */
export const sessionField = (uuid: string, field: "tty" | "contents"): string => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is ${asString(uuid)} then return ${field} of s
      end repeat
    end repeat
  end repeat
  return ${asString(GONE)}
end tell`;
