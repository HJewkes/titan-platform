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

export type TranscribeMode = "subtitles" | "whisper";

export interface TranscribeEnv {
  ytRoot: string;
  runner: Runner;
}

export function classifyStderr(stderr: string): StepErrorClass {
  if (/HTTP Error 429|Too Many Requests/i.test(stderr)) return "http429";
  if (/no (usable )?(subtitles|captions)|has no (auto-generated )?captions/i.test(stderr)) return "no_captions";
  if (/live event will begin|premieres in|This live event/i.test(stderr)) return "upcoming";
  if (/is live|live stream recording is not available/i.test(stderr)) return "live";
  return "other";
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
  const args = [path.join(env.ytRoot, "extract.py"), "--anchors", ...(mode === "whisper" ? ["--whisper"] : []), `https://www.youtube.com/watch?v=${id}`];
  // Whisper is CPU-heavy, so it runs at the lowest priority.
  const result = await (mode === "whisper" ? env.runner("nice", ["-n", "19", python, ...args]) : env.runner(python, args));
  const wrote = WROTE.exec(result.stdout);
  if (result.code === 0 && wrote) {
    return { ok: true, value: { path: wrote[1]!, via: viaOf(wrote[2]!), words: countWords(wrote[1]!) } };
  }
  return { ok: false, errorClass: classifyStderr(result.stderr), message: result.stderr.trim().split("\n").at(-1) ?? "" };
}
