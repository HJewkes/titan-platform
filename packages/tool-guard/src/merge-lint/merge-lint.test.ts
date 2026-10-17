import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { classify } from "../index.js";
import { buildReport } from "./report.js";
import { parseRules } from "./rules.js";
import type { Rules } from "./rules.js";
import { run } from "./run.js";
import type { RunIo } from "./run.js";
import { scan } from "./scan.js";
import type { SourceFile } from "./scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, "fixtures", name), "utf-8");

const BASE_RULES = {
  $schema: "merge-lint/1",
  level: "warn",
  scan: { include: ["**/*"], brief: ["**/CLAUDE.md", "briefs/**"] },
  exclude: ["**/*.test.*", "docs/**"],
  allow: [],
};

function rulesWith(patch: Record<string, unknown> = {}): Rules {
  const parsed = parseRules(JSON.stringify({ ...BASE_RULES, ...patch }));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rules;
}

function hitsIn(text: string, rules: Rules = rulesWith()): Array<[number, string]> {
  return scan([{ path: "src/x.ts", text }], rules).findings.map((f) => [f.line, f.shape]);
}

describe("each merge call shape in a scanned file warns at its starting line", () => {
  it.each([
    ["gh pr merge", "run gh pr merge 42 now", "gh-pr-merge"],
    ["gh pr merge with global flags", "gh -R o/r pr merge 7", "gh-pr-merge"],
    ["gh pr merge with an equals flag", "gh --repo=o/r pr merge 7", "gh-pr-merge"],
    ["gh pr merge in other case", "GH PR MERGE 7", "gh-pr-merge"],
    ["a soft-wrapped gh pr merge", "then gh pr\nmerge 9", "gh-pr-merge"],
    ["a REST pulls merge", "gh api -X PUT repos/o/r/pulls/7/merge", "rest-pr-merge"],
    ["a route string with placeholders", "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", "rest-pr-merge"],
    ["a template literal", "`repos/${repo}/pulls/${number}/merge`", "rest-pr-merge"],
    ["a branch merge", "POST repos/o/r/merges", "rest-branch-merge"],
    ["a branch merge through one template", "`repos/${repo}/merges`", "rest-branch-merge"],
    ["mergePullRequest", "mutation { mergePullRequest(input: {}) }", "graphql-merge"],
    ["enablePullRequestAutoMerge", "enablePullRequestAutoMerge(input: {})", "graphql-merge"],
    ["enqueuePullRequest", "enqueuePullRequest(input: {})", "graphql-merge"],
    ["octokit pulls.merge", "octokit.pulls.merge({ pull_number: 1 })", "octokit-merge"],
    ["octokit rest.pulls.merge", "octokit.rest.pulls.merge({ pull_number: 1 })", "octokit-merge"],
  ])("%s", (_name, text, shape) => {
    expect(hitsIn(`first line\n${text}`)).toEqual([[2, shape]]);
  });

  it.each([
    ["a disable-auto cancel", "gh pr merge 5 --disable-auto"],
    ["seat-merge", "seat-merge seat o/r 5 abc /clone"],
    ["git merge-base", "git merge-base origin/main HEAD"],
    ["a PR view", "gh pr view 5"],
    ["merge-upstream", "repos/o/r/merge-upstream"],
    ["update-branch", "pulls/5/update-branch"],
  ])("%s does not warn", (_name, text) => {
    expect(hitsIn(text)).toEqual([]);
  });
});

describe("a gh pr merge in an agent brief warns", () => {
  it("the agent-brief fixture warns at lines 1-7 and the clean fixture warns at none", () => {
    const brief = scan([{ path: "agent-brief.md", text: fixture("agent-brief.md") }], rulesWith(), { scoped: false });
    const clean = scan([{ path: "agent-brief-clean.md", text: fixture("agent-brief-clean.md") }], rulesWith(), { scoped: false });

    expect(brief.findings.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(clean.findings).toEqual([]);
  });

  it("a brief under briefs/ in a git repo is scanned", () => {
    const repo = tempRepo({ "briefs/tc-x.md": fixture("agent-brief.md").split("\n").at(0) ?? "" });
    const result = runIn(repo, []);

    expect(result.out).toContain("merge-lint: warn briefs/tc-x.md:1: gh-pr-merge");
  });

  it("a brief piped on stdin is scanned", () => {
    const io = fakeIo({ stdin: fixture("agent-brief.md") });

    const code = run(["--stdin", "--name", "spawn-brief"], io.io);

    expect(code).toBe(0);
    expect(io.out.filter((l) => l.includes("spawn-brief:"))).toHaveLength(7);
  });
});

interface FakeIo {
  io: RunIo;
  out: string[];
  err: string[];
}

function fakeIo(options: { rules?: string | null; files?: SourceFile[]; stdin?: string; env?: Record<string, string> } = {}): FakeIo {
  const out: string[] = [];
  const err: string[] = [];
  const rules = options.rules === undefined ? JSON.stringify(BASE_RULES) : options.rules;
  const io: RunIo = {
    env: options.env ?? {},
    readRules: () => rules,
    trackedFiles: () => options.files ?? [],
    readStdin: () => options.stdin ?? "",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err };
}

const OFFENDER: SourceFile[] = [{ path: "src/a.ts", text: "gh pr merge 1\n" }];

describe("the exit code", () => {
  it("warn level exits 0 with findings", () => {
    const fake = fakeIo({ files: OFFENDER });

    expect(run([], fake.io)).toBe(0);
    expect(fake.out[0]).toContain("src/a.ts:1");
  });

  it("error level exits 1 with an unallowed hit", () => {
    const fake = fakeIo({ files: OFFENDER, rules: JSON.stringify({ ...BASE_RULES, level: "error" }) });

    expect(run([], fake.io)).toBe(1);
  });

  it("error level exits 0 when every hit is allowed", () => {
    const allow = [{ path: "src/a.ts", kind: "detector", reason: "test" }];
    const fake = fakeIo({ files: OFFENDER, rules: JSON.stringify({ ...BASE_RULES, level: "error", allow }) });

    expect(run([], fake.io)).toBe(0);
  });

  it.each([
    ["missing", null],
    ["not JSON", "{"],
    ["an unknown key", JSON.stringify({ ...BASE_RULES, extra: 1 })],
    ["a wrong schema tag", JSON.stringify({ ...BASE_RULES, $schema: "merge-lint/2" })],
  ])("a %s rule file exits 2 at warn level", (_name, rules) => {
    const fake = fakeIo({ files: OFFENDER, rules });

    expect(run([], fake.io)).toBe(2);
    expect(fake.out).toEqual([]);
  });

  it("an unknown argument exits 2", () => {
    expect(run(["--bogus"], fakeIo().io)).toBe(2);
  });
});

describe("an allowlist covers only what it names", () => {
  const detector = (path: string, extra: Record<string, unknown> = {}) => ({ path, kind: "detector", reason: "test", ...extra });

  it("an allowed wrapper path does not warn", () => {
    const allow = [{ path: "src/a.ts", kind: "wrapper", mergePath: "w", logs: true, reason: "test" }];

    const result = scan(OFFENDER, rulesWith({ allow }));

    expect(result.findings.map((f) => f.allowedBy)).toEqual([0]);
    expect(buildReport(result, rulesWith({ allow }), false).unallowed).toBe(0);
  });

  it("a different path stays unallowed", () => {
    const result = scan(OFFENDER, rulesWith({ allow: [detector("src/b.ts")] }));

    expect(result.findings.map((f) => f.allowedBy)).toEqual([null]);
  });

  it("a text-pinned entry leaves other hits in the same file warning", () => {
    const text = '"Bash(gh pr merge:*)"\nrun gh pr merge 3\n';
    const allow = [detector("profiles/p.json", { kind: "deny-list", text: '"Bash(gh pr merge:*)"' })];

    const result = scan([{ path: "profiles/p.json", text }], rulesWith({ allow }));

    expect(result.findings.map((f) => [f.line, f.allowedBy])).toEqual([[1, 0], [2, null]]);
  });

  it("a glob entry covers files below it", () => {
    const result = scan([{ path: "pkg/src/deep/a.ts", text: "gh pr merge 1" }], rulesWith({ allow: [detector("pkg/src/**")] }));

    expect(result.findings[0]?.allowedBy).toBe(0);
  });
});

describe("the allowlist cannot silently widen", () => {
  it.each(["**", "*", "**/*"])("an entry whose path glob is %s is refused (exit 2)", (path) => {
    const allow = [{ path, kind: "detector", reason: "test" }];
    const fake = fakeIo({ files: OFFENDER, rules: JSON.stringify({ ...BASE_RULES, allow }) });

    expect(run([], fake.io)).toBe(2);
    expect(fake.err[0]).toContain("covers every file");
  });

  it("an entry matching no hit warns as stale", () => {
    const allow = [{ path: "src/gone.ts", kind: "detector", reason: "test" }];
    const fake = fakeIo({ files: OFFENDER, rules: JSON.stringify({ ...BASE_RULES, allow }) });

    run([], fake.io);

    expect(fake.out.some((l) => l.includes("stale allow entry") && l.includes("src/gone.ts"))).toBe(true);
  });

  it("a wrapper with logs:false warns once", () => {
    const allow = [{ path: "src/a.ts", kind: "wrapper", mergePath: "w", logs: false, reason: "test" }];
    const fake = fakeIo({ files: OFFENDER, rules: JSON.stringify({ ...BASE_RULES, allow }) });

    run([], fake.io);

    expect(fake.out.filter((l) => l.includes("does not log yet"))).toHaveLength(1);
  });

  it("a renamed wrapper leaves its old entry stale and its new file unallowed", () => {
    const allow = [{ path: "src/old.ts", kind: "wrapper", mergePath: "w", logs: true, reason: "test" }];
    const rules = rulesWith({ allow });

    const result = scan([{ path: "src/new.ts", text: "gh pr merge 1" }], rules);

    expect(result.stale).toEqual([0]);
    expect(buildReport(result, rules, false).unallowed).toBe(1);
  });
});

describe("the report format", () => {
  it("prints a path:line warning in a plain log", () => {
    const fake = fakeIo({ files: OFFENDER });

    run([], fake.io);

    expect(fake.out[0]).toBe("merge-lint: warn src/a.ts:1: gh-pr-merge: a merge call outside the allowlist in .github/merge-lint.json: gh pr merge 1");
  });

  it("prints a workflow annotation under GitHub Actions", () => {
    const fake = fakeIo({ files: OFFENDER, env: { GITHUB_ACTIONS: "true" } });

    run([], fake.io);

    expect(fake.out[0]).toBe("::warning file=src/a.ts,line=1,title=merge-lint::gh-pr-merge: a merge call outside the allowlist in .github/merge-lint.json: gh pr merge 1");
  });

  it("escapes a percent sign in the quoted line", () => {
    const fake = fakeIo({ files: [{ path: "a.md", text: "gh pr merge 100%\n" }], env: { GITHUB_ACTIONS: "true" } });

    run([], fake.io);

    expect(fake.out[0]).toContain("100%25");
  });
});

describe("tool-guard and the lint agree on what a merge is", () => {
  const COMMANDS = [
    "gh pr merge 42 --squash",
    "gh -R o/r pr merge 7 --auto",
    "gh api -X PUT repos/o/r/pulls/7/merge -f sha=abc",
    "gh api -X POST repos/o/r/merges -f base=b -f head=h",
    "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
  ];

  it.each(COMMANDS)("every positive command fixture is classified bash.merge.* and flagged: %s", (command) => {
    const ctx = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };
    const event = { kind: "bash" as const, command, cwd: "/home/you/app", toolName: "Bash", sessionId: null, toolUseId: null };

    const actions = classify(event, ctx);

    expect(actions.some((a) => a.spelling.startsWith("bash.merge."))).toBe(true);
    expect(hitsIn(command)).not.toEqual([]);
  });
});

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "merge-lint-"));
  dirs.push(dir);
  const all = { ".github/merge-lint.json": JSON.stringify(BASE_RULES), ...files };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function runIn(cwd: string, args: string[]): { code: number; out: string } {
  const bin = join(here, "..", "..", "dist", "merge-lint-bin.js");
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf-8" });
  return { code: result.status ?? -1, out: result.stdout };
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf-8" }).filter((p) => !p.startsWith(".git/") && p !== ".git").sort();
}

describe("the lint has no consumer", () => {
  it("a lint run leaves the repo and its parent untouched", () => {
    const repo = tempRepo({ "briefs/b.md": "gh pr merge 1\n", "src/ok.ts": "export {}\n" });
    const before = [listing(repo), listing(dirname(repo)).filter((p) => !p.includes("/"))];

    runIn(repo, []);

    expect([listing(repo), listing(dirname(repo)).filter((p) => !p.includes("/"))]).toEqual(before);
  });

  it("merge-lint imports only node built-ins and its own modules", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const specifiers = sources.flatMap((f) => [...readFileSync(join(here, f), "utf-8").matchAll(/from "([^"]+)"/g)].map((m) => m[1] ?? ""));

    const foreign = specifiers.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && s !== "zod");

    expect(sources.length).toBeGreaterThan(5);
    expect(foreign).toEqual([]);
  });
});
