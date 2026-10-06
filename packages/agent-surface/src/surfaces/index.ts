import { SURFACE_NAMES, type Surface, type SurfaceName } from "../types.js";
import type { Launcher } from "./command.js";
import { headlessSurface } from "./headless.js";
import { itermSurface } from "./iterm.js";
import { SurfaceRefused, type SurfaceOptions } from "./options.js";
import { tmuxSurface } from "./tmux.js";

/**
 * Where a spawned agent is presented, and the only place that knows what a pane
 * is. Every name is routed explicitly and anything else is refused, since a
 * name read from a profile at runtime is not checked by the type.
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
    case "iterm-pane":
    case "iterm-tab":
    case "iterm-window":
      return itermSurface(name, launcher, options);
    default:
      throw new SurfaceRefused(`unknown surface '${String(name)}'; expected one of ${SURFACE_NAMES.join(", ")}`);
  }
}
