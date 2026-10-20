import type { Ancestry, Unavailable } from "./classify.js";

/** The `compareAncestry` seam of `GitHubPort` and of the guard; a port satisfies it as is. */
interface AncestrySource {
  compareAncestry(repo: string, base: string, head: string): Promise<Ancestry | Unavailable>;
}

/** A head read that differs from the head a site holds. */
interface ObservedHead {
  repo: string;
  pr: number;
  held: string;
  read: string;
}

export type HeadObserver = (seen: ObservedHead) => void;
type HeadLog = (line: string) => void;

/** Where the `head-regression` lines go until a host names a sink; F11 counts them from the daemon log. */
const defaultHeadLog: HeadLog = (line) => console.warn(line);

/**
 * Observe-only (TP-3097 S5): asks whether the read head is behind the held one and logs one line when it is. It never
 * rejects and changes no site's answer; a failed ancestry read logs nothing.
 */
export async function logIfBehind(port: AncestrySource, log: HeadLog, seen: ObservedHead): Promise<void> {
  if (seen.read === seen.held) return;
  try {
    if ((await port.compareAncestry(seen.repo, seen.held, seen.read)) !== "behind") return;
    log(`head-regression repo=${seen.repo} pr=${seen.pr} held=${seen.held} read=${seen.read}`);
  } catch {
    // an ancestry failure is not a finding; the site already acted on its read
  }
}

export function headRegressionObserver(port: AncestrySource, log: HeadLog = defaultHeadLog): HeadObserver {
  return (seen) => void logIfBehind(port, log, seen);
}
