import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import type { Verbs } from "../cli.js";
import { EXIT } from "../exit-codes.js";
import { assertRule, buildReport, formatReport, type AuditedSession } from "./report.js";
import { scanTranscript } from "./scan.js";

interface ContextAuditOpts {
  days: number;
  root?: string;
  assertRule?: string[];
}

const DAY_MS = 86_400_000;

function parseDays(value: string): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) throw new InvalidArgumentError("expected a positive number of days");
  return days;
}

const dirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

/** `<root>/<profile>/projects/<project>/*.jsonl` modified since the cutoff; subagent transcripts one level deeper are not sessions. */
function readSessions(root: string, since: number): AuditedSession[] {
  return dirs(root).flatMap((profile) =>
    dirs(path.join(root, profile, "projects")).flatMap((project) => {
      const dir = path.join(root, profile, "projects", project);
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl") && statSync(path.join(dir, f)).mtimeMs >= since)
        .map((f) => ({ profile, project, scan: scanTranscript(readFileSync(path.join(dir, f), "utf8")) }));
    }),
  );
}

function contextAudit(opts: ContextAuditOpts, { io, setExit }: Verbs, now: () => number): void {
  if (opts.assertRule && opts.assertRule.length !== 2) {
    io.stderr("error: --assert-rule takes exactly two values: <marker> <roles>, roles comma-separated\n");
    return setExit(EXIT.USAGE);
  }
  const root = opts.root ?? path.join(io.env.HOME || homedir(), ".claude-profiles");
  const since = now() - opts.days * DAY_MS;
  const report = buildReport(readSessions(root, since), since);
  if (!opts.assertRule) return io.stdout(formatReport(report, opts.days));
  const [marker = "", roles = ""] = opts.assertRule;
  const result = assertRule(report, marker, roles.split(",").map((r) => r.trim()).filter(Boolean));
  io.stdout(`${result.lines.join("\n")}\n`);
  setExit(result.ok ? EXIT.OK : EXIT.FAILURE);
}

/** `titan-factory context-audit`: spend by role and per-profile context inventory from local Claude Code transcripts, read-only. */
export function registerContextAudit(program: Command, verbs: Verbs, now: () => number = Date.now): void {
  program
    .command("context-audit")
    .description("per role class: sessions, calls, turn-1 context, cache write/read, output and API-equivalent USD; per profile and role: the newest prompt snapshot's system blocks, tool schemas and instructions files; carried tool-result chars by kind; wakes by trigger per coordinator")
    .option("--days <n>", "transcripts modified in the last n days", parseDays, 7)
    .option("--root <dir>", "the profiles directory holding <profile>/projects/<project>/*.jsonl (default ~/.claude-profiles)")
    .option("--assert-rule <marker-and-roles...>", "<marker> <roles>: exit 1 unless every listed role's newest system prompt, in every profile, contains the marker sentence")
    .action((opts: ContextAuditOpts) => contextAudit(opts, verbs, now));
}
