import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fresh `perf` log directory under the system temp dir; the caller removes it with `removeDir`. */
export function makeLogDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "perf-recorder-")), "perf");
}

export function removeDir(logDir: string): void {
  rmSync(path.dirname(logDir), { recursive: true, force: true });
}

export function logFileNames(logDir: string): string[] {
  return readdirSync(logDir).sort();
}

export function readLogText(logDir: string): string {
  return logFileNames(logDir)
    .map((file) => readFileSync(path.join(logDir, file), "utf8"))
    .join("");
}

export function seedLog(logDir: string, file: string, text: string): void {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, file), text);
}
