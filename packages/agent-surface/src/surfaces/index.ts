import type { Surface, SurfaceName } from "../types.js";
import type { Launcher } from "./command.js";
import { headlessSurface } from "./headless.js";
import { itermSurface, type ItermSurfaceName } from "./iterm.js";
import type { SurfaceOptions } from "./options.js";

/**
 * Where a spawned agent is presented, and the only place that knows what a pane
 * is. A `tmux-pane` surface would be a drop-in here and invisible everywhere else.
 *
 * Surfaces are built per launch rather than kept as singletons because the anchor
 * belongs to the requesting connection: reusing one surface across requests would
 * land one requester's spawn in another's window.
 */

const isIterm = (name: SurfaceName): name is ItermSurfaceName => name !== "headless";

export function surfaceFor(name: SurfaceName, launcher: Launcher, options: SurfaceOptions = {}): Surface {
  return isIterm(name) ? itermSurface(name, launcher, options) : headlessSurface(launcher, options);
}
