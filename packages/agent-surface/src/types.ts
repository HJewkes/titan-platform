export const SURFACE_NAMES = ["headless", "iterm-pane", "iterm-tab", "iterm-window", "tmux-window"] as const;

export type SurfaceName = (typeof SURFACE_NAMES)[number];

/** The surfaces that put the agent in front of a human who can answer a prompt. */
export const isInteractiveSurface = (surface: SurfaceName): boolean => surface !== "headless";

/**
 * Everything the launcher needs to start one agent, written to disk by the spawner.
 *
 * A surface never sees `bin` or `args`: it launches the fixed launcher command,
 * which reads this plan, so a model-authored brief never reaches a command line.
 */
export interface LaunchPlan {
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

export interface LaunchHandle {
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
  exited?: Promise<{ code: number | null; signal: string | null }>;
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
export interface CloseOutcome {
  closed: boolean;
  reason?: string;
}

export interface Surface {
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
