import { spawn as nodeSpawn } from "node:child_process";
import type { CloseOutcome, LaunchHandle, LaunchPlan, Surface } from "../types.js";
import type { Launcher } from "./command.js";
import type { SurfaceOptions } from "./options.js";

/**
 * Exported so the regression test can spawn a real, loud process through the very
 * same stdio arrangement. Asserting the literal in a unit test would only restate
 * it; running a megabyte through it is what proves nothing blocks.
 */
export const HEADLESS_STDIO = ["ignore", "ignore", "ignore"] as const;

/**
 * No terminal at all: a detached child with nowhere for its output to go.
 * Detached is the load-bearing part: the host is what survives every session,
 * and an agent it spawned must not die with the request.
 */
export function headlessSurface(launcher: Launcher, options: SurfaceOptions = {}): Surface {
  return {
    name: "headless",
    interactive: false,
    launch: async (plan: LaunchPlan): Promise<LaunchHandle> => {
      const spawn = options.spawn ?? nodeSpawn;
      const [bin = process.execPath, ...args] = launcher.argv(plan.agentId);
      const child = spawn(bin, args, {
        detached: true,
        // DISCARDED, and this must stay discarded. Piped streams with no reader let a
        // chatty agent fill the ~64KB kernel buffer, block on write, and wedge forever
        // while still looking healthy. A reader in the host cannot fix it: the child
        // outlives the host by design, so only /dev/null drains it safely. The agent's
        // own transcript is the record.
        stdio: [...HEADLESS_STDIO],
      });
      child.unref();

      // Settled rather than pending, so nothing here keeps the host's event loop alive.
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        child.once("exit", (code: number | null, signal: string | null) => resolve({ code, signal }));
        child.once("error", () => resolve({ code: null, signal: null }));
      });

      return {
        surface: "headless",
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        exited,
      };
    },
    /** Nothing to close: having no surface is what headless means. */
    close: async (): Promise<CloseOutcome> => ({ closed: false, reason: "headless: no surface to close" }),
  };
}
