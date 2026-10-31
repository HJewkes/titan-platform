import path from "node:path";
import { z } from "zod";

const DIST = "apps/console/dist";
const NON_EMPTY = ["cli.js", "index.html"] as const;

export interface FlushPorts {
  /** Flushes the filesystem holding `dir` to disk (`sync -f`); why not, or undefined once it is flushed. */
  syncFs: (dir: string) => Promise<string | undefined>;
  /** Bytes in `file`; undefined when it is missing. */
  fileSize: (file: string) => number | undefined;
  readFile: (file: string) => string | undefined;
  log: (line: string) => void;
  now: () => number;
}

const stampSchema = z.object({ sha: z.string() });

function stampedSha(text: string | undefined): string | undefined {
  try {
    const parsed = stampSchema.safeParse(JSON.parse(text ?? ""));
    return parsed.success ? parsed.data.sha : undefined;
  } catch {
    return undefined;
  }
}

/** Why `release` is not a whole build of `sha`, or undefined when its bin and page have bytes and its stamp names `sha`. */
export function releaseFault(ports: Pick<FlushPorts, "fileSize" | "readFile">, release: string, sha: string): string | undefined {
  for (const name of NON_EMPTY) {
    const size = ports.fileSize(path.join(release, DIST, name));
    if (size === undefined || size === 0) return `${DIST}/${name} is ${size === undefined ? "missing" : "empty"}`;
  }
  const stamped = stampedSha(ports.readFile(path.join(release, DIST, "build-info.json")));
  return stamped === sha ? undefined : `${DIST}/build-info.json names ${stamped ?? "no sha"}, not ${sha}`;
}

/**
 * The swap is a rename, which can reach the disk before the release's own pages do: a power loss then leaves
 * `current` on files of 0 bytes (TP-4638). So the release is flushed first and read back before `current` may name it.
 */
export async function flushRelease(ports: FlushPorts, release: string, sha: string): Promise<string | undefined> {
  const started = ports.now();
  const unsynced = await ports.syncFs(release);
  if (unsynced !== undefined) return `sync -f ${release} failed: ${unsynced}`;
  const fault = releaseFault(ports, release, sha);
  if (fault !== undefined) return `${release} is not a whole build after its flush: ${fault}`;
  ports.log(`flushed ${release} to disk in ${ports.now() - started} ms`);
  return undefined;
}
