import type { SpawnOptions } from "node:child_process";
import type { LaunchCheckTiming, ProcessProbe } from "./launch-check.js";

/**
 * Runs one AppleScript and resolves with its trimmed output. Injected so tests
 * need no macOS.
 *
 * Async because a host serving many sessions is one event loop. A synchronous
 * `osascript` stopped it dead for as long as iTerm2 took to answer, measured at
 * five seconds during a burst of spawns.
 */
export type AppleScriptRunner = (script: string) => Promise<string>;

/**
 * The slice of `child_process.spawn` a surface uses. Injected for the same reason.
 *
 * `once` is here because a host infers a headless agent's exit from the child
 * itself; a fake that omitted it would let a test pass while the real exit path
 * was never wired.
 */
export interface SpawnedChild {
  pid?: number | undefined;
  unref: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors node's overloaded listener signatures
  once: (event: string, listener: (...args: any[]) => void) => unknown;
}

export type SpawnFn = (bin: string, args: string[], options: SpawnOptions) => SpawnedChild;

export interface SurfaceOptions {
  /**
   * The requester's `ITERM_SESSION_ID`. Absent means "no anchor", which is a
   * normal case, not an error: the window surface needs none.
   */
  anchor?: string;
  /**
   * The pane of the last agent already stacked beside this anchor, if any. A new
   * agent splits THAT rather than the anchor, so the requester's pane is not
   * halved once per spawn.
   */
  columnAfter?: string;
  /**
   * Which side of the anchor a pane's stack starts on: `right` (the default)
   * keeps the anchor's height, `below` keeps its width. A live `columnAfter`
   * pane is split downwards either way.
   */
  split?: "right" | "below";
  /**
   * The most sessions a tab may hold. A pane asked for in a tab already this
   * full opens as a tab in the anchor's window instead, with a notice.
   */
  maxInTab?: number;
  /**
   * An iTerm2 window id. A tab opens in this window with no anchor needed, and
   * a pane whose anchor is absent or gone lands there as a tab before it falls
   * back to a window of its own.
   */
  tabWindow?: number | string;
  /**
   * Put the agent IN the anchor session rather than beside it.
   *
   * Only for a successor taking over a predecessor's own pane, which it has just
   * vacated. Never set for a spawn: an agent must not be able to type into a pane
   * somebody else is working in, and the anchor of a spawn is the requester's
   * live pane.
   */
  reuseAnchor?: boolean;
  /** The tmux session a `tmux-window` surface opens its window in; default `fac`. */
  tmuxSession?: string;
  /** A tmux socket name (`tmux -L`); absent means tmux's own default, which honours `$TMUX`. */
  tmuxSocket?: string;
  /** Told when a surface silently downgrades, e.g. the anchor pane has closed. */
  onNotice?: (message: string) => void;
  runAppleScript?: AppleScriptRunner;
  /** Lists what runs on a pane's tty, for the launch check. Injected so tests need no `ps`. */
  probeProcesses?: ProcessProbe;
  /** How long, and how often, the launch check looks for the launcher. Shortened in tests. */
  launchCheck?: LaunchCheckTiming;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
}

/**
 * The surface cannot present the agent at all, as opposed to presenting it
 * somewhere less specific. Distinct from a plain Error so a host can record a
 * refusal rather than treating it as a crash.
 */
export class SurfaceRefused extends Error {
  override readonly name = "SurfaceRefused";
}
