export type { CloseOutcome, LaunchHandle, LaunchPlan, Surface, SurfaceName } from "./types.js";
export { SURFACE_NAMES, isInteractiveSurface } from "./types.js";
export { surfaceFor } from "./surfaces/index.js";
export type { Launcher } from "./surfaces/command.js";
export { launchCommand, paneCommand, relaunchCommand, relaunchScript, shellQuote } from "./surfaces/command.js";
export { HEADLESS_STDIO, headlessSurface } from "./surfaces/headless.js";
export type { ItermSurfaceName } from "./surfaces/iterm.js";
export { itermSessionPresent, itermSurface } from "./surfaces/iterm.js";
export type { LaunchCheckTiming, LaunchMarker, PaneReader, ProcessProbe } from "./surfaces/launch-check.js";
export { LAUNCH_CHECK_TIMING, psProbe, watchLaunch } from "./surfaces/launch-check.js";
export type { AppleScriptRunner, SpawnedChild, SpawnFn, SurfaceOptions } from "./surfaces/options.js";
export { SurfaceRefused } from "./surfaces/options.js";
export type { RunAgentOptions } from "./run-agent.js";
export { LAUNCHER_PID_ENV, LaunchBinUnresolved, launchEnv, readLaunchPlan, runAgent } from "./run-agent.js";
export type { LaunchArgs } from "./launch-args.js";
export { LAUNCH_USAGE, parseLaunchArgs } from "./launch-args.js";
export {
  OUTPUT_TAIL_BYTES,
  clearOutputTail,
  loginGap,
  outputTailPath,
  readOutputTail,
  tailKeeper,
  writeOutputTail,
} from "./launch-output.js";
export type { PaneColourConfig, PaneSources, Rgb, SeatPrefix } from "./pane-identity.js";
export {
  NO_PANE_SOURCES,
  PANE_PALETTE,
  coordinatorOf,
  hashedColour,
  isHexColour,
  isITerm,
  itermIdentity,
  oscTitle,
  paneColour,
  paneEscapes,
  parseHex,
} from "./pane-identity.js";
