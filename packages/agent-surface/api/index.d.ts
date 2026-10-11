import { SpawnOptions } from 'node:child_process';

declare const SURFACE_NAMES: readonly ["headless", "iterm-pane", "iterm-tab", "iterm-window", "tmux-window"];
type SurfaceName = (typeof SURFACE_NAMES)[number];
/** The surfaces that put the agent in front of a human who can answer a prompt. */
declare const isInteractiveSurface: (surface: SurfaceName) => boolean;
/**
 * Everything the launcher needs to start one agent, written to disk by the spawner.
 *
 * A surface never sees `bin` or `args`: it launches the fixed launcher command,
 * which reads this plan, so a model-authored brief never reaches a command line.
 */
interface LaunchPlan {
    agentId: string;
    bin: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    /** Variables the launcher deletes from the inherited env, since an empty string is not the same as unset. */
    unsetEnv?: string[];
    /** Headless only: the prompt goes on stdin, never in argv. */
    stdin?: string;
    title: string;
    surface: SurfaceName;
}
interface LaunchHandle {
    surface: SurfaceName;
    /** Headless only. */
    pid?: number;
    /** iTerm session UUID, or a tmux window id (`@N`). */
    paneRef?: string;
    /**
     * How many sessions the anchor's tab held when this launch looked, before it
     * opened anything. Only for a launch placed by its anchor.
     */
    inTab?: number;
    /**
     * This launch OPENED the surface, so its owner may also close it.
     *
     * Absent for a pane the launch only wrote INTO: an anchor belongs to whoever
     * was already sitting in it. Only a split, tab or window this launch created
     * sets it.
     */
    ownsSurface?: boolean;
    /**
     * Resolves when the process ends. Headless ONLY: the host does not own an
     * iTerm pane's process, so a visible agent's exit has to be inferred from
     * presence instead, and can never carry an exit code.
     */
    exited?: Promise<{
        code: number | null;
        signal: string | null;
    }>;
    /**
     * Visible only, for a pane the launch opened or reused: resolves with a reason
     * once the surface has seen the launch fail before the agent could start, and
     * never resolves otherwise. Like `exited`, it cannot be persisted.
     */
    launchFailed?: Promise<string>;
}
/**
 * The outcome of a teardown. `closed` means the surface went back and looked,
 * since "the close script ran" and "the pane is gone" have diverged in practice;
 * `reason` is what it saw when the answer is no.
 */
interface CloseOutcome {
    closed: boolean;
    reason?: string;
}
interface Surface {
    readonly name: SurfaceName;
    readonly interactive: boolean;
    launch(plan: LaunchPlan): Promise<LaunchHandle>;
    /**
     * Tear down the surface this handle was launched on, and report whether it is
     * actually gone. A no-op unless `ownsSurface` is set; the check lives here, in
     * the only layer that knows what a pane is, so no caller can skip it.
     */
    close(handle: LaunchHandle): Promise<CloseOutcome>;
}

/**
 * The one command every surface launches, supplied by the host as a `Launcher`.
 *
 * A surface never sees `plan.bin` or `plan.args`. The plan is already on disk and
 * the launcher is what reads it, which keeps a model-authored brief out of every
 * command line: AppleScript only ever carries a fixed string with an agent id in it.
 */
interface Launcher {
    /** The full argv that starts one agent; `argv[0]` is the executable. */
    argv(agentId: string): string[];
    /**
     * Variables a pane's shell must be handed explicitly. A pane opens in a fresh
     * login shell with the user's environment, not the host's, so a relocated
     * state directory is invisible to it unless carried here.
     */
    env?: Record<string, string>;
    /** Where the in-place relaunch script for this agent lives; only a reused pane types it. */
    relaunchPath(agentId: string): string;
}
/** Single-quoted for /bin/sh: paths here are ours, but they can still hold spaces. */
declare const shellQuote: (word: string) => string;
/** For surfaces that hand a shell a line to type, rather than spawning argv directly. */
declare const launchCommand: (launcher: Launcher, agentId: string) => string;
/**
 * For a pane the host opens: the command is given to iTerm at creation, so it is
 * never typed into a shell whose input the human can reach.
 *
 * `zsh -lic` for the environment a typed command used to get: `-l` for PATH from
 * .zprofile, `-i` for whatever .zshrc exports. `exec /bin/zsh -l` afterwards
 * keeps the pane, and whatever the launcher printed, open after it exits or crashes.
 */
declare const paneCommand: (launcher: Launcher, agentId: string) => string;
/**
 * The only thing still typed into a shell: a reused pane has no creation
 * `command` to take, so it gets this short fixed path instead of the full
 * command line. Keys that join it in front make it a different, failing command;
 * keys typed between it and the newline become arguments, which a correct
 * invocation never has.
 */
declare const relaunchCommand: (launcher: Launcher, agentId: string) => string;
/** The script `relaunchCommand` runs; the host writes it to `launcher.relaunchPath(agentId)`. */
declare const relaunchScript: (launcher: Launcher, agentId: string) => string;

/**
 * Did the launcher actually start in the pane just opened?
 *
 * The host does not own a pane's process, so without this a launch that died at
 * the shell (`zsh: command not found: s`, exit 127, after keystrokes joined the
 * typed command) read as "still starting" until the attach window ran out. A
 * pane's tty is the one handle that reaches its processes, and `ps -t` answers
 * from it.
 *
 * Only a positive answer of absence fails a launch. A `ps` that errors, a tty
 * this check does not recognise, or a pane that has closed all mean "cannot
 * say", and the host's ordinary attach window keeps deciding those. A pane
 * whose tty stays `''` until the deadline counts as absent: a pane with no tty
 * has no process on it, so the launcher is not running there.
 */
/** Command lines of the processes on a tty. Rejects when it cannot tell. */
type ProcessProbe = (tty: string) => Promise<string[]>;
/** What a surface can read back off the pane it opened. */
interface PaneReader {
    /** The pane's tty, `''` while it has none yet, undefined once the pane is gone. */
    tty: () => Promise<string | undefined>;
    contents: () => Promise<string>;
}
interface LaunchCheckTiming {
    deadlineMs: number;
    pollMs: number;
}
declare const LAUNCH_CHECK_TIMING: LaunchCheckTiming;
/** `-ww` because ps otherwise cuts the line at 80 columns, before the agent id. */
declare const psProbe: ProcessProbe;
/**
 * The last two words of the launcher's argv, e.g. a verb and the agent id. The
 * launcher process carries them as two bare words; a shell wrapper's -c string
 * quotes them, so it never matches.
 */
type LaunchMarker = readonly [string, string];
/**
 * Resolves with a failure reason when the launch is known to have failed, and
 * never resolves otherwise, which is the shape a host's attach wait races.
 */
declare function watchLaunch(pane: PaneReader, probe: ProcessProbe, marker: LaunchMarker, timing?: LaunchCheckTiming): Promise<string>;

/**
 * Runs one AppleScript and resolves with its trimmed output. Injected so tests
 * need no macOS.
 *
 * Async because a host serving many sessions is one event loop. A synchronous
 * `osascript` stopped it dead for as long as iTerm2 took to answer, measured at
 * five seconds during a burst of spawns.
 */
type AppleScriptRunner = (script: string) => Promise<string>;
/**
 * The slice of `child_process.spawn` a surface uses. Injected for the same reason.
 *
 * `once` is here because a host infers a headless agent's exit from the child
 * itself; a fake that omitted it would let a test pass while the real exit path
 * was never wired.
 */
interface SpawnedChild {
    pid?: number | undefined;
    unref: () => void;
    once: (event: string, listener: (...args: any[]) => void) => unknown;
}
type SpawnFn = (bin: string, args: string[], options: SpawnOptions) => SpawnedChild;
interface SurfaceOptions {
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
declare class SurfaceRefused extends Error {
    readonly name = "SurfaceRefused";
}

/**
 * Where a spawned agent is presented, and the only place that knows what a pane
 * is. Every name is routed explicitly and anything else is refused, since a
 * name read from a profile at runtime is not checked by the type.
 *
 * Surfaces are built per launch rather than kept as singletons because the anchor
 * belongs to the requesting connection: reusing one surface across requests would
 * land one requester's spawn in another's window.
 */
declare function surfaceFor(name: SurfaceName, launcher: Launcher, options?: SurfaceOptions): Surface;

/**
 * Exported so the regression test can spawn a real, loud process through the very
 * same stdio arrangement. Asserting the literal in a unit test would only restate
 * it; running a megabyte through it is what proves nothing blocks.
 */
declare const HEADLESS_STDIO: readonly ["ignore", "ignore", "ignore"];
/**
 * No terminal at all: a detached child with nowhere for its output to go.
 * Detached is the load-bearing part: the host is what survives every session,
 * and an agent it spawned must not die with the request.
 */
declare function headlessSurface(launcher: Launcher, options?: SurfaceOptions): Surface;

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
type ItermSurfaceName = Extract<SurfaceName, `iterm-${string}`>;

/**
 * Whether iTerm2 still holds `uuid`, for callers outside a teardown.
 *
 * Unknown (undefined) is a third answer and not a synonym for either: iTerm2 not
 * running, a non-Mac, or osascript failing all mean this cannot say.
 */
declare function itermSessionPresent(uuid: string, options?: SurfaceOptions): Promise<boolean | undefined>;
declare function itermSurface(name: ItermSurfaceName, launcher: Launcher, options?: SurfaceOptions): Surface;

/** The persistent session a factory host's seats live in, unless options name another. */
declare const TMUX_SESSION = "fac";
/**
 * Whether the tmux server still holds window `windowId` (`@N`, unique per
 * server), for a host inferring that an agent exited. Unknown (undefined) means
 * this cannot say, and is a synonym for neither answer.
 */
declare function tmuxWindowPresent(windowId: string, options?: SurfaceOptions): Promise<boolean | undefined>;
/**
 * A seat in a window of a persistent tmux session, for a host with no iTerm2.
 * Resume is an ordinary launch: the old window closed with its agent, so a new
 * one opens.
 */
declare function tmuxSurface(launcher: Launcher, options?: SurfaceOptions): Surface;

/**
 * What makes an interactive agent's pane recognisable at a glance. The name is
 * the title and the badge; the tab colour says which coordinator the agent
 * belongs to, so every agent of one seat shares the seat's colour.
 *
 * The coordinator is found from the agent's NAME, not its recorded spawner: the
 * launcher reads only the launch plan, and a seat keys its agents by name prefix.
 */
/** A seat's name and the prefix its agents' names start with. */
interface SeatPrefix {
    name: string;
    prefix: string;
}
/** A `#rrggbb` per seat and per profile, both optional. */
interface PaneColourConfig {
    seats: Record<string, string>;
    profiles: Record<string, string>;
}
interface Rgb {
    r: number;
    g: number;
    b: number;
}
/** Mid-brightness hues that stay apart from each other on a dark or a light tab bar. */
declare const PANE_PALETTE: readonly ["#d9534f", "#e8833a", "#d4b200", "#6aa84f", "#2e9e8f", "#3d85c6", "#674ea7", "#c2478f", "#8e6c3a", "#5b8c2a", "#1f6f8b", "#a64d79"];
declare const isHexColour: (value: unknown) => value is string;
declare function parseHex(hex: string): Rgb | undefined;
declare const hashedColour: (key: string) => string;
/**
 * The coordinator an agent belongs to: the seat it is, or whose prefix its name
 * carries. With no seat to match, the name's first segment stands in for one.
 */
declare function coordinatorOf(name: string, seats: readonly SeatPrefix[]): string;
/** A seat's colour beats a profile's: one coordinator's agents share a colour whatever their profile. */
declare function paneColour(name: string, profile: string | undefined, seats: readonly SeatPrefix[], config: PaneColourConfig): string;
/** Control characters are stripped so a name can never end the title early and start another sequence. */
declare const oscTitle: (title: string) => string;
/** iTerm's proprietary tab colour (OSC 6) and badge (OSC 1337 SetBadgeFormat, base64 of the text). */
declare function itermIdentity(name: string, colour: Rgb): string;
declare const isITerm: (env: NodeJS.ProcessEnv) => boolean;
/** Where the pane's colour comes from: host inputs, so this package reads no charter or config. */
interface PaneSources {
    seats: () => SeatPrefix[];
    colours: () => PaneColourConfig;
    /** The profile a plan was launched under, for the profile colour; absent means none. */
    profile?: (plan: LaunchPlan) => string | undefined;
}
declare const NO_PANE_SOURCES: PaneSources;
/**
 * Title via OSC 0 rather than iTerm's `set name`, which does not stick: iTerm
 * overwrites it with the running job. In iTerm the tab colour and badge follow;
 * any other terminal gets the title alone, and a headless agent nothing.
 */
declare function paneEscapes(plan: LaunchPlan, env: NodeJS.ProcessEnv, sources?: PaneSources): string;

/**
 * The fixed command every surface launches. It reads the plan, sets the terminal
 * title, and runs the binary with an argv ARRAY. No shell is involved at any
 * point, which is what makes it safe for a model-authored brief to be in the
 * plan at all.
 */
/** The default name of the variable that carries the launcher's own pid to the process it launched. */
declare const LAUNCHER_PID_ENV = "TITAN_AGENT_LAUNCHER_PID";
/** The launcher pid comes last so no plan can forge it. */
declare const launchEnv: (planEnv: Record<string, string>, base: Record<string, string>, launcherPid?: number, unset?: readonly string[], launcherPidEnv?: string) => Record<string, string>;
/** A `bin` the launcher could not turn into something to exec; the launcher exits 127 with this message. */
declare class LaunchBinUnresolved extends Error {
    readonly name = "LaunchBinUnresolved";
}
interface RunAgentOptions {
    /** The agent's own directory, where the stderr tail is left for the host. */
    agentDir: string;
    /** The env the plan's env is layered over. Defaults to this process's env; a host passes its scrubbed env. */
    baseEnv?: Record<string, string>;
    /** Turns `plan.bin` into what is exec'd, in the process that execs. Throw `LaunchBinUnresolved` to exit 127. */
    resolveBin?: (bin: string) => string;
    launcherPidEnv?: string;
    paneSources?: PaneSources;
    /** Prefix for the launcher's own messages on stderr. */
    label?: string;
}
/** Reads a plan the host wrote; the host owns its shape, so only the fields the launcher execs are checked. */
declare function readLaunchPlan(file: string): LaunchPlan;
/** Writes the pane escapes and execs the plan; this process exits the way the launched one did. */
declare function runAgent(plan: LaunchPlan, options: RunAgentOptions): void;

declare const LAUNCH_USAGE = "usage: titan-agent-launch [--launcher-pid-env NAME] <plan.json>";
interface LaunchArgs {
    planFile: string;
    launcherPidEnv?: string;
}
/** The bin's whole command line: one plan file, and optionally the variable that carries the launcher pid. */
declare function parseLaunchArgs(argv: readonly string[]): LaunchArgs | {
    error: string;
};

/**
 * The tail of a headless claude's stderr, kept where the host can read it.
 *
 * The host cannot hold the pipe (see surfaces/headless.ts), so the launcher that
 * outlives it does: it drains claude's stderr, keeps a bounded tail, and leaves it
 * in the agent's directory when claude exits. The host reads the file only to
 * explain a failed launch.
 */
declare const OUTPUT_TAIL_BYTES = 4096;
declare const outputTailPath: (agentDir: string) => string;
/** Keeps the last `limit` characters however much is appended. */
declare function tailKeeper(limit?: number): {
    append(chunk: string): void;
    text(): string;
};
declare function writeOutputTail(agentDir: string, text: string): void;
/** A resume reuses the agent dir, so a tail from an earlier launch must not outlive it. */
declare function clearOutputTail(agentDir: string): void;
declare function readOutputTail(agentDir: string): string | undefined;
/** The login diagnosis when `output` carries claude's not-logged-in signature, else undefined. */
declare function loginGap(output: string | undefined, configDir: string | undefined): string | undefined;

export { type AppleScriptRunner, type CloseOutcome, HEADLESS_STDIO, type ItermSurfaceName, LAUNCHER_PID_ENV, LAUNCH_CHECK_TIMING, LAUNCH_USAGE, type LaunchArgs, LaunchBinUnresolved, type LaunchCheckTiming, type LaunchHandle, type LaunchMarker, type LaunchPlan, type Launcher, NO_PANE_SOURCES, OUTPUT_TAIL_BYTES, PANE_PALETTE, type PaneColourConfig, type PaneReader, type PaneSources, type ProcessProbe, type Rgb, type RunAgentOptions, SURFACE_NAMES, type SeatPrefix, type SpawnFn, type SpawnedChild, type Surface, type SurfaceName, type SurfaceOptions, SurfaceRefused, TMUX_SESSION, clearOutputTail, coordinatorOf, hashedColour, headlessSurface, isHexColour, isITerm, isInteractiveSurface, itermIdentity, itermSessionPresent, itermSurface, launchCommand, launchEnv, loginGap, oscTitle, outputTailPath, paneColour, paneCommand, paneEscapes, parseHex, parseLaunchArgs, psProbe, readLaunchPlan, readOutputTail, relaunchCommand, relaunchScript, runAgent, shellQuote, surfaceFor, tailKeeper, tmuxSurface, tmuxWindowPresent, watchLaunch, writeOutputTail };
