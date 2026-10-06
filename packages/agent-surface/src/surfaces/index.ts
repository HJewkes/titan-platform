import type { Surface, SurfaceName } from "../types.js";
import type { Launcher } from "./command.js";
import { headlessSurface } from "./headless.js";
import { itermSurface } from "./iterm.js";
import type { SurfaceOptions } from "./options.js";
import { tmuxSurface } from "./tmux.js";

/**
 * Where a spawned agent is presented, and the only place that knows what a pane
 * is. Every name is routed explicitly, so a new one cannot fall through to
 * AppleScript.
 *
 * Surfaces are built per launch rather than kept as singletons because the anchor
 * belongs to the requesting connection: reusing one surface across requests would
 * land one requester's spawn in another's window.
 */
export function surfaceFor(name: SurfaceName, launcher: Launcher, options: SurfaceOptions = {}): Surface {
  switch (name) {
    case "headless":
      return headlessSurface(launcher, options);
    case "tmux-window":
      return tmuxSurface(launcher, options);
    default:
      return itermSurface(name, launcher, options);
  }
}
