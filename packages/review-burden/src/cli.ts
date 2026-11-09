import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ChangedFile } from "./config.js";
import { doorFacts, effectiveDoor, underDeclared, type ChangesetBump, type DoorFacts } from "./door.js";
import { parseFooter, type Footer } from "./footer.js";
import { burdenScore, type BurdenScore } from "./score.js";

export const BODY_ENV = "REVIEW_BURDEN_BODY";

export interface CliDeps {
  /** The `git diff -M --numstat <base>...HEAD` output. */
  diff(base: string): string;
  readText(path: string): string;
  env: Readonly<Record<string, string | undefined>>;
  out(text: string): void;
  err(text: string): void;
}

interface Options {
  base: string;
  bodyFile?: string;
  enforce: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { base: "origin/main", enforce: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--enforce") options.enforce = true;
    else if (arg === "--base" || arg === "--body-file") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === "--base") options.base = value;
      else options.bodyFile = value;
    } else throw new Error(`unknown argument ${arg ?? ""}`);
  }
  return options;
}

/** Expands numstat's `a/{b => c}/d` and `a => b` rename paths to the base and head paths. */
function renamePaths(raw: string): { path: string; previousPath?: string } {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (brace) {
    const [, pre = "", from = "", to = "", post = ""] = brace;
    const clean = (middle: string) => `${pre}${middle}${post}`.replace(/\/{2,}/g, "/");
    return { path: clean(to), previousPath: clean(from) };
  }
  const plain = / => /.exec(raw);
  if (plain) return { path: raw.slice(plain.index + 4), previousPath: raw.slice(0, plain.index) };
  return { path: raw };
}

function parseNumstat(text: string): ChangedFile[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [add = "0", del = "0", ...rest] = line.split("\t");
      const { path, previousPath } = renamePaths(rest.join("\t"));
      const file: ChangedFile = {
        path,
        status: previousPath ? "renamed" : "modified",
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
      };
      if (previousPath) file.previousPath = previousPath;
      return file;
    });
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
  try {
    options = parseArgs(argv);
  } catch (error) {
    deps.err(`review-burden: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const files = parseNumstat(deps.diff(options.base));
  const body = readBody(options, deps);
  const score = burdenScore({ files, body });
  const door = doorFacts({ files, changesetBumps: changesetBumps(files, deps.readText) });
  const footer = parseFooter(body);
  const effective = effectiveDoor(footer.door, door.door);
  deps.out(`${burdenTable(score)}\n`);
  deps.out(`${JSON.stringify({ score, door, declaredDoor: footer.door ?? null, effectiveDoor: effective, footer })}\n`);
  const problems = remediation(footer, door);
  if (!options.enforce || problems.length === 0) return 0;
  for (const problem of problems) deps.err(`review-burden: ${problem}\n`);
  return 1;
}

export function realDeps(): CliDeps {
  return {
    diff: (base) => execFileSync("git", ["diff", "-M", "--numstat", `${base}...HEAD`], { encoding: "utf8" }),
    readText: (path) => readFileSync(path, "utf8"),
    env: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
