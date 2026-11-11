import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseBurdenConfig } from "./bin-config.js";
import type { BurdenConfig, ChangedFile } from "./config.js";
import { doorFacts, effectiveDoor, underDeclared, type ChangesetBump, type DoorFacts } from "./door.js";
import { changedFiles } from "./git-diff.js";
import { parseFooter, type Footer } from "./footer.js";
import { burdenScore, type BurdenScore } from "./score.js";

export const BODY_ENV = "REVIEW_BURDEN_BODY";

export interface CliDeps {
  /** The `git diff -M --numstat -z <base>...HEAD` output. */
  diff(base: string): string;
  /** The `git diff -M --name-status -z <base>...HEAD` output; the same `-M` as `diff`, so renames pair up. */
  nameStatus(base: string): string;
  readText(path: string): string;
  env: Readonly<Record<string, string | undefined>>;
  out(text: string): void;
  err(text: string): void;
}

interface Options {
  base: string;
  bodyFile?: string;
  configPath?: string;
  enforce: boolean;
}

function assignValue(options: Options, arg: "--base" | "--body-file" | "--config", value: string): void {
  if (arg === "--base") options.base = value;
  else if (arg === "--body-file") options.bodyFile = value;
  else options.configPath = value;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { base: "origin/main", enforce: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--enforce") options.enforce = true;
    else if (arg === "--base" || arg === "--body-file" || arg === "--config") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      assignValue(options, arg, value);
    } else throw new Error(`unknown argument ${arg ?? ""}`);
  }
  return options;
}

function changesetBumps(files: readonly ChangedFile[], readText: CliDeps["readText"]): ChangesetBump[] {
  const bumps: ChangesetBump[] = [];
  for (const { path } of files) {
    if (!/^\.changeset\/(?!README).*\.md$/.test(path)) continue;
    let text: string;
    try {
      text = readText(path);
    } catch {
      continue;
    }
    for (const match of text.matchAll(/^["']?[^:\n]+["']?\s*:\s*(major|minor|patch)\s*$/gm)) {
      const bump = match[1];
      if (bump === "major" || bump === "minor" || bump === "patch") bumps.push(bump);
    }
  }
  return bumps;
}

function readConfig(options: Options, deps: CliDeps): Partial<BurdenConfig> {
  if (!options.configPath) return {};
  return parseBurdenConfig(deps.readText(options.configPath), options.configPath);
}

function readBody(options: Options, deps: CliDeps): string {
  if (options.bodyFile) return deps.readText(options.bodyFile);
  return deps.env[BODY_ENV] ?? "";
}

function burdenTable(score: BurdenScore): string {
  const rows = Object.entries(score.parts).map(([part, points]) => `${part.padEnd(10)} ${String(points).padStart(3)}`);
  return [...rows, `${"total".padEnd(10)} ${String(score.total).padStart(3)}`].join("\n");
}

function remediation(footer: Footer, door: DoorFacts): string[] {
  const problems: string[] = [];
  if (!footer.present) {
    problems.push(
      "The PR body has no complete merge-danger footer. Add the marker `<!-- merge-danger:v1 -->` followed by `Door:` (one-way or two-way), `Blast radius:`, `Rollback:` and `Contract:` lines.",
    );
  }
  if (underDeclared(footer.door, door.door)) {
    const named = door.facts.map((fact) => fact.path ?? fact.kind).join(", ");
    problems.push(`The footer declares Door: two-way but the diff is one-way (${named}). Declare Door: one-way.`);
  }
  return problems;
}

/** Prints the table and a JSON line; returns the exit code. Only `--enforce` can make it non-zero. */
export function run(argv: readonly string[], deps: CliDeps): number {
  let options: Options;
  let config: Partial<BurdenConfig>;
  try {
    options = parseArgs(argv);
    config = readConfig(options, deps);
  } catch (error) {
    deps.err(`review-burden: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const files = changedFiles(deps.diff(options.base), deps.nameStatus(options.base));
  const body = readBody(options, deps);
  const score = burdenScore({ files, body, config });
  const door = doorFacts({ files, changesetBumps: changesetBumps(files, deps.readText), config });
  const footer = parseFooter(body);
  const effective = effectiveDoor(footer.door, door.door);
  deps.out(`${burdenTable(score)}\n`);
  deps.out(`${JSON.stringify({ score, door, declaredDoor: footer.door ?? null, effectiveDoor: effective, footer })}\n`);
  const problems = remediation(footer, door);
  if (!options.enforce || problems.length === 0) return 0;
  for (const problem of problems) deps.err(`review-burden: ${problem}\n`);
  return 1;
}

function gitDiff(format: "--numstat" | "--name-status", base: string): string {
  return execFileSync("git", ["diff", "-M", format, "-z", `${base}...HEAD`], { encoding: "utf8" });
}

export function realDeps(): CliDeps {
  return {
    diff: (base) => gitDiff("--numstat", base),
    nameStatus: (base) => gitDiff("--name-status", base),
    readText: (path) => readFileSync(path, "utf8"),
    env: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
