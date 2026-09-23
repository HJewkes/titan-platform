import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { heredoc } from "./fake-bin.js";
import type { FakeBin } from "./fake-bin.js";

// Output captured from the real tools; see fixtures/python-audit/README.md for versions and commands.
export const CAPTURED = fileURLToPath(new URL("../../fixtures/python-audit", import.meta.url));
export const PROJECT = realpathSync(join(CAPTURED, "project"));
export const LAYERED = realpathSync(join(CAPTURED, "layered"));

export function captured(name: string): string {
  return readFileSync(join(CAPTURED, name), "utf-8");
}

export interface Replay {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  /** Extra shell run before the output, e.g. to keep a copy of a generated config. */
  before?: string;
}

/** Installs `command` as a fake that records its arguments, then prints the given output. */
export function replay(bin: FakeBin, command: string, output: Replay): void {
  const lines = [`printf '%s\\n' "$@" > "$(dirname "$0")/args.txt"`, output.before ?? ""];
  if (output.stdout !== undefined) lines.push(heredoc(output.stdout));
  if (output.stderr !== undefined) lines.push(heredoc(output.stderr, "stderr"));
  bin.install(command, [...lines, `exit ${output.exitCode}`].join("\n"));
  bin.onPathFirst();
}

export function seenArgs(bin: FakeBin): string[] {
  return readFileSync(join(bin.dir, "args.txt"), "utf-8").trimEnd().split("\n");
}
