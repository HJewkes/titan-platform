import { activeWorkRoot } from "@titan-design/app-paths";
import { activeWorkOrigin } from "./active-work-origin.js";
import { activeWorkFollowUpTasks } from "./cleanup-ports.js";
import { fileFollowUpDigest } from "./follow-up-digest.js";
import type { FollowUpSinks } from "./follow-ups-file.js";

/** Shepherd's step and the seat verb file into the same places: active-work's tasks over loopback, and the digest file beside them. */
export function liveFollowUpSinks(env: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch): FollowUpSinks {
  return {
    tasks: activeWorkFollowUpTasks({ origin: activeWorkOrigin(env), ...(fetch && { fetch }) }),
    digest: fileFollowUpDigest(activeWorkRoot({ env }), Date.now),
  };
}
