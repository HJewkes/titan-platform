import { parseFrameData } from "../events.js";
import { stripControls } from "../format.js";
import type { Snapshot } from "../snapshot.js";

const STDERR_KEPT = 2_000;

/** The feed and the mod ship from one build, so the frame's outline is enough to trust the rest. */
function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  if (!("atMs" in value && "agents" in value && "accounts" in value && "errors" in value)) return false;
  return typeof value.atMs === "number" && Array.isArray(value.agents) && Array.isArray(value.accounts) && Array.isArray(value.errors);
}

/**
 * What the mod knows from the feed's output: the newest snapshot it printed, and why the
 * feed stopped if it did. Chunks arrive cut at arbitrary points, so lines are joined first.
 */
export class FeedReader {
  snapshot: Snapshot | null = null;
  /** Set when the feed exits or prints a line that is not a snapshot. */
  problem: string | null = null;
  private pending = "";
  private stderr = "";

  /** True when the snapshot changed. */
  stdout(text: string): boolean {
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) {
      if (line.trim() === "") continue;
      const parsed = parseFrameData(line);
      if (!isSnapshot(parsed)) {
        this.problem = `the feed printed a line that is not a snapshot: ${stripControls(line).slice(0, 80)}`;
        continue;
      }
      this.snapshot = parsed;
      this.problem = null;
      changed = true;
    }
    return changed;
  }

  stderrText(text: string): void {
    this.stderr = (this.stderr + text).slice(-STDERR_KEPT);
  }

  exited(how: string): void {
    const tail = this.stderr.trim().split("\n").pop();
    this.problem = stripControls(`the feed ${how}${tail ? `: ${tail}` : ""}`);
  }
}
