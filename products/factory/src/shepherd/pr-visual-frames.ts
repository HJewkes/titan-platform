// TP-6776: how many frames the head's pr-visual artifact rendered, read before a visual gate asks the owner. The count
// can only keep an owner gate from opening, never clear a visual row or merge, so a forged count costs the PR its gate.
import { errorClass } from "./error-class.js";
import { DEFAULT_LIMITS, execPrVisualGh, manifestOf, openHeadArtifact, type PrVisualGh } from "./pr-visual-evidence.js";
import type { PrVisualFrames } from "./spawn-ports.js";

const WORKFLOW = ".github/workflows/pr-visual.yml";

/** A frame is a shot with a head render; a manifest that says it rendered nothing has none, whatever it lists. */
async function framesOnce(gh: PrVisualGh, repo: string, head: string): Promise<number | string> {
  const zip = await openHeadArtifact(gh, { repo, head, workflow: WORKFLOW, pixelTolerance: 0 }, DEFAULT_LIMITS);
  if (typeof zip === "string") return zip;
  const manifest = manifestOf(zip);
  if (typeof manifest === "string") return manifest;
  if (manifest.headSha !== head) return "the artifact was captured for another head";
  return manifest.rendered ? manifest.shots.filter((shot) => shot.after !== undefined).length : 0;
}

/** Never throws: a failed read is its reason, and the caller treats an unread count as no evidence either way. */
export function prVisualFrames(gh: PrVisualGh = execPrVisualGh()): PrVisualFrames {
  return async (repo, head) => {
    try {
      return await framesOnce(gh, repo, head);
    } catch (error) {
      return `the frame read failed: ${errorClass(error)}`;
    }
  };
}
