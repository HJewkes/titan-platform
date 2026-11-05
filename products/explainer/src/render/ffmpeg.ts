import { spawn } from "node:child_process";

/** Runs ffmpeg quietly and resolves with its stdout; a non-zero exit rejects with its stderr. */
export function runFfmpeg(args: readonly string[], bin = "ffmpeg"): Promise<string> {
  const proc = spawn(bin, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  proc.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  return new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
    });
  });
}
