import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StepUsage } from "@titan-design/workflow";
import type { Voided } from "../judge/index.js";

export type Stage = "compile" | "screen" | "confirm";

/** One model call's cost, as the runner reported it; the cost report folds these per stage and model. */
export interface UsageEntry {
  stepId: string;
  model: string;
  usage: StepUsage;
}

/** What one judged batch left on disk. `via` names the call whose verdict counted, so a resume replays only that one. */
export interface BatchArtifact<T> {
  key: string;
  stage: Exclude<Stage, "compile">;
  round?: number;
  /** For a confirm batch, the book it holds. */
  book?: string;
  via: "primary" | "redo" | "unjudged";
  passageIds: string[];
  items: T[];
  voided: Voided[];
  unjudged: string[];
  flagged: boolean;
  /** Calls on this batch whose canary was mis-judged, the redo included. */
  canaryMisses: number;
  reason?: string;
  usage: UsageEntry[];
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Atomic, so a crash mid-write never leaves a half artifact that a resume would trust. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

export interface RunPaths {
  runDir: string;
  spec: string;
  compile: string;
  answer: string;
  batch: (stage: "screen" | "confirm", key: string, round?: number) => string;
}

export function runPaths(dataDir: string, runId: string): RunPaths {
  const runDir = path.join(dataDir, "runs", runId);
  return {
    runDir,
    spec: path.join(runDir, "spec.json"),
    compile: path.join(runDir, "compile.json"),
    answer: path.join(runDir, "answer.json"),
    batch: (stage, key, round) => path.join(runDir, stage, round === undefined ? "" : `r${round}`, `${key}.json`),
  };
}

/** Specs and rulings are stored by content hash, so a resumed run rebuilds the exact prefix it started with. */
export function storeContent(dataDir: string, kind: "specs" | "rules", text: string): string {
  const sha = sha256(text);
  const file = contentPath(dataDir, kind, sha);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return sha;
}

export function readContent(dataDir: string, kind: "specs" | "rules", sha: string): string {
  const text = readFileSync(contentPath(dataDir, kind, sha), "utf8");
  if (sha256(text) !== sha) throw new Error(`${kind}/${sha} no longer matches its hash`);
  return text;
}

const contentPath = (dataDir: string, kind: "specs" | "rules", sha: string): string => path.join(dataDir, kind, `${sha}.${kind === "specs" ? "json" : "md"}`);
