/**
 * The console's way to Shepherd's `log-frames` verb (TP-6777). The console does not import titan-factory, so, like the
 * by-rec rows, it runs the installed CLI with a fixed argv and no shell. A missing CLI, a failed run or a reply of another
 * shape is an error the log builder skips, so the row is tried again on a later build.
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import type { Captured, FramesCapture } from "./log-frames.js";
import { childEnv } from "./log-gate-rows.js";

/** Each run lists the artifact, downloads it and decodes its shots under Shepherd's own caps. */
const CLI_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const reply: z.ZodType<Captured> = z.object({
  line: z.string(),
  variantKeys: z.array(z.string()),
  reason: z.string().optional(),
  failed: z.literal(true).optional(),
});

export function parseCaptured(stdout: string): Captured | { error: string } {
  try {
    const parsed = reply.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : { error: "shepherd log-frames: the reply has another shape" };
  } catch {
    return { error: "shepherd log-frames: the reply was not JSON" };
  }
}

export function factoryLogFrames(bin: string | undefined): FramesCapture {
  if (bin === undefined) return async () => ({ error: "titan-factory is not on PATH" });
  return ({ repo, pr, head, dir }) =>
    new Promise((resolve) => {
      const args = ["shepherd", "log-frames", "--repo", repo, "--pr", String(pr), "--head", head, "--dir", dir, "--json"];
      execFile(bin, args, { timeout: CLI_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", env: childEnv() }, (error, stdout, stderr) => {
        if (error === null) return resolve(parseCaptured(stdout));
        resolve({ error: `shepherd log-frames: ${(stderr.trim().split("\n")[0] ?? "") || error.message}` });
      });
    });
}
