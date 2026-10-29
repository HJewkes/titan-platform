import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { StepErrorClass, StepOutcome, Transcript } from "./seams.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The process boundary: tests inject a fake, production spawns the youtube tree's extract.py. */
export type Runner = (command: string, args: string[]) => Promise<RunResult>;

export const execRunner: Runner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout, stderr });
    });
  });

type TranscribeMode = "subtitles" | "whisper";

export interface TranscribeEnv {
  ytRoot: string;
  runner: Runner;
}

// extract.py's own exit text when the video has neither subtitles nor auto-captions in the asked language.
const NO_CAPTIONS = /^no '[^']*' subtitles or auto-captions\b/m;
// extract.py probes with capture_output and no try block, so a failed probe leaves only this traceback line.
const PROBE_FAILED = /CalledProcessError: Command .*'--dump-single-json'/;

function classifyStderr(stderr: string): StepErrorClass {
  if (/HTTP Error 429|Too Many Requests/i.test(stderr)) return "http429";
  if (NO_CAPTIONS.test(stderr)) return "no_captions";
  if (/live event will begin|premieres in/i.test(stderr)) return "upcoming";
  if (/live stream recording is not available|is live/i.test(stderr)) return "live";
  return "other";
}

const LIVE_STATUS: Record<string, StepErrorClass> = { is_upcoming: "upcoming", is_live: "live", post_live: "live" };

function liveStatusOf(stdout: string): StepErrorClass | undefined {
  try {
    const status = (JSON.parse(stdout) as { live_status?: unknown }).live_status;
    return typeof status === "string" ? LIVE_STATUS[status] : undefined;
  } catch {
    return undefined;
  }
}

/** Re-run extract.py's probe to recover what it hides: yt-dlp's stderr, or a live stream with no captions yet. */
async function diagnose(env: TranscribeEnv, url: string, errorClass: StepErrorClass, stderr: string): Promise<StepErrorClass> {
  const probeFailed = errorClass === "other" && PROBE_FAILED.test(stderr);
  if (!probeFailed && errorClass !== "no_captions") return errorClass;
  const probe = await env.runner(path.join(env.ytRoot, ".venv", "bin", "yt-dlp"), ["--dump-single-json", "--flat-playlist", "--no-warnings", url]);
  if (probeFailed) return classifyStderr(probe.stderr);
  return (probe.code === 0 && liveStatusOf(probe.stdout)) || errorClass;
}

const WROTE = /^Wrote (.+?) \([\d,]+ chars from (.+)\)\s*$/m;

function viaOf(source: string): Transcript["via"] {
  if (source.startsWith("whisper")) return "whisper";
  return /auto/i.test(source) ? "auto-captions" : "subtitles";
}

function countWords(file: string): number {
  const text = readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  return text.split(/\s+/).filter(Boolean).length;
}

/** Run extract.py for one video and turn its output into a transcript or a classified failure. */
export async function transcribeVideo(env: TranscribeEnv, id: string, mode: TranscribeMode): Promise<StepOutcome<Transcript>> {
  const python = path.join(env.ytRoot, ".venv", "bin", "python");
  const url = `https://www.youtube.com/watch?v=${id}`;
  const args = [path.join(env.ytRoot, "extract.py"), "--anchors", ...(mode === "whisper" ? ["--whisper"] : []), url];
  // Whisper is CPU-heavy, so it runs at the lowest priority.
  const result = await (mode === "whisper" ? env.runner("nice", ["-n", "19", python, ...args]) : env.runner(python, args));
  const wrote = WROTE.exec(result.stdout);
  if (result.code === 0 && wrote) {
    return { ok: true, value: { path: wrote[1]!, via: viaOf(wrote[2]!), words: countWords(wrote[1]!) } };
  }
  const errorClass = await diagnose(env, url, classifyStderr(result.stderr), result.stderr);
  return { ok: false, errorClass, message: result.stderr.trim().split("\n").at(-1) ?? "" };
}
