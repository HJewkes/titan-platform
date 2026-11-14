import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import { commandName, gitSubcommand, shellScript, shellSegments, SHELLS, substitutions, unwrap, withoutHeredocData } from "./shell-words.js";

/** Where a job may look: its own workspace and HOME. The operator's home is named so a finding says whose it was. */
export interface AuditRoots {
  workspace: string;
  jobHome: string;
  operatorHome: string;
}

type AuditRule = "denied-command" | "proxy-override" | "operator-path" | "outside-path";

interface AuditFinding {
  /** 1-based transcript line of the tool call. */
  line: number;
  tool: string;
  rule?: AuditRule;
  detail: string;
}

export interface AuditResult {
  contaminated: boolean;
  violations: AuditFinding[];
  /** Calls the CLI refused; they ran nothing, so they never void a job. */
  deniedAttempts: AuditFinding[];
}

const DENIED_NAMES = new Set(["gh", "curl", "wget", "ssh", "scp", "sftp", "nc", "ncat", "netcat", "titan-factory", "agent-chat", "active-work", "titan-console"]);
const DENIED_GIT = new Set(["push", "fetch", "pull", "remote", "clone"]);
const PROXY_OVERRIDES = [
  /\bunset\b[^;&|\n]*\b(?:https?|all|no)_proxy\b/i,
  /\benv\b[^;&|\n]*\s(?:-u\s*|--unset[=\s])(?:https?|all|no)_proxy\b/i,
  /--noproxy\b/,
  /(?:^|[\s;&|('"])(?:export\s+)?(?:https?|all|no)_proxy=/i,
];
const SYSTEM_ROOTS = ["/usr", "/bin", "/lib", "/etc/ssl", "/tmp"];
const EXACT_ALLOWED = new Set(["/dev/null"]);
/** A word such as sed's `/start/,/end/p` starts with `/` too; only a top-level dir that exists makes it a path. */
const TOP_LEVEL_DIRS = ["bin", "boot", "dev", "etc", "home", "lib", "lib64", "media", "mnt", "opt", "proc", "root", "run", "sbin", "srv", "sys", "tmp", "usr", "var", "Users", "Volumes", "private", "nix", "snap", "work"];

function deniedCommand(words: readonly string[], depth: number): string | undefined {
  const command = unwrap(words);
  const name = commandName(command[0] ?? "");
  if (SHELLS.has(name) || name === "eval") {
    const script = name === "eval" ? command.slice(1).join(" ") : shellScript(command);
    return script === undefined || depth > 4 ? undefined : deniedIn(script, depth + 1);
  }
  if (DENIED_NAMES.has(name)) return name;
  if (name === "git" && DENIED_GIT.has(gitSubcommand(command) ?? "")) return `git ${gitSubcommand(command) ?? ""}`;
  return undefined;
}

function deniedIn(command: string, depth = 0): string | undefined {
  const nested = substitutions(command).map((body) => deniedIn(body, depth + 1));
  return [...shellSegments(command).map((segment) => deniedCommand(segment.words, depth)), ...nested].find((hit) => hit !== undefined);
}

/** Every word of a command, including those of nested `sh -c` scripts, that could name a file. */
function wordsOf(command: string, depth = 0): string[] {
  const segments = shellSegments(command);
  const flat = segments.flatMap((segment) => [...segment.words, ...segment.redirects]);
  const scripts = segments.flatMap((segment) => {
    const script = SHELLS.has(commandName(unwrap(segment.words)[0] ?? "")) ? shellScript(unwrap(segment.words)) : undefined;
    return script === undefined || depth > 4 ? [] : wordsOf(script, depth + 1);
  });
  return [...flat, ...scripts, ...substitutions(command).flatMap((body) => wordsOf(body, depth + 1))];
}

/** `~` is the job's HOME: the job env replaces HOME, so a tilde never reaches the operator's. */
function absolutePath(value: string, roots: AuditRoots): string | undefined {
  if (value.startsWith("~")) return posix.join(roots.jobHome, value.slice(1));
  return value.startsWith("/") ? posix.normalize(value) : undefined;
}

/** Relative words are left alone: the job's cwd moves with `cd`, so resolving them would guess. */
function pathOfWord(word: string, roots: AuditRoots): string | undefined {
  const value = /^[^/~]*=[/~]/.test(word) ? word.slice(word.indexOf("=") + 1) : word;
  const path = absolutePath(value, roots);
  if (path === undefined || value.startsWith("~")) return path;
  const top = value.split("/")[1] ?? "";
  const ownTops = [roots.workspace, roots.jobHome, roots.operatorHome].map((root) => root.split("/")[1]);
  return TOP_LEVEL_DIRS.includes(top) || ownTops.includes(top) ? path : undefined;
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`);

function pathRule(path: string, roots: AuditRoots): AuditRule | undefined {
  if (EXACT_ALLOWED.has(path) || [roots.workspace, roots.jobHome, ...SYSTEM_ROOTS].some((root) => within(path, root))) return undefined;
  return within(path, roots.operatorHome) ? "operator-path" : "outside-path";
}

type Hit = { rule: AuditRule; detail: string };

function bashHits(command: string, roots: AuditRoots): Hit[] {
  const scanned = withoutHeredocData(command);
  const denied = deniedIn(scanned);
  const proxy = PROXY_OVERRIDES.some((pattern) => pattern.test(scanned));
  const paths = wordsOf(scanned).flatMap((word) => {
    const path = pathOfWord(word, roots);
    const rule = path === undefined ? undefined : pathRule(path, roots);
    return rule === undefined ? [] : [{ rule, detail: `${path ?? ""} in: ${command}` }];
  });
  return [...(denied === undefined ? [] : [{ rule: "denied-command" as const, detail: command }]), ...(proxy ? [{ rule: "proxy-override" as const, detail: command }] : []), ...paths];
}

/** Grep's `pattern` is a regex, so only the fields that always hold a path are read. */
const PATH_FIELDS: Record<string, readonly string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  Grep: ["path"],
  Glob: ["path", "pattern"],
};

function toolHits(name: string, input: Record<string, unknown>, roots: AuditRoots): Hit[] {
  if (name === "Bash") return typeof input.command === "string" ? bashHits(input.command, roots) : [];
  return (PATH_FIELDS[name] ?? []).flatMap((field) => {
    const value = input[field];
    const path = typeof value === "string" ? absolutePath(value, roots) : undefined;
    const rule = path === undefined ? undefined : pathRule(path, roots);
    return rule === undefined ? [] : [{ rule, detail: `${field}=${path ?? ""}` }];
  });
}

const ContentItem = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
});
const TranscriptLine = z.looseObject({ type: z.string().optional(), message: z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]).optional() }).optional() });
const CliDenials = z.looseObject({ permission_denials: z.array(z.looseObject({ tool_use_id: z.string() })).optional() });

const REFUSAL = /Permission to use \S+ (?:with command [\s\S]* )?has been denied|denied by your permission settings/;

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("\n") : "";

interface ToolUse {
  line: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function itemsOf(text: string): { line: number; item: z.infer<typeof ContentItem> }[] {
  return text.split("\n").flatMap((raw, index) => {
    try {
      const parsed = TranscriptLine.safeParse(JSON.parse(raw));
      const content = parsed.success ? parsed.data.message?.content : undefined;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        const item = ContentItem.safeParse(part);
        return item.success ? [{ line: index + 1, item: item.data }] : [];
      });
    } catch {
      return [];
    }
  });
}

/** Tool calls, and the ids the CLI refused: from the transcript's own refusal results and the CLI's `permission_denials`. */
function readCalls(text: string, cliResult: unknown): { uses: ToolUse[]; refused: Set<string> } {
  const uses: ToolUse[] = [];
  const refused = new Set<string>();
  for (const { line, item } of itemsOf(text)) {
    if (item.type === "tool_use" && item.id !== undefined && item.name !== undefined) uses.push({ line, id: item.id, name: item.name, input: item.input ?? {} });
    if (item.type === "tool_result" && item.tool_use_id !== undefined && item.is_error === true && REFUSAL.test(textOf(item.content))) refused.add(item.tool_use_id);
  }
  const cli = CliDenials.safeParse(cliResult);
  for (const denial of (cli.success ? cli.data.permission_denials : undefined) ?? []) refused.add(denial.tool_use_id);
  return { uses, refused };
}

/**
 * The post-hoc trace audit (design 4.7): any call that ran and reached a denied tool, overrode the dead proxy, or
 * named a path outside the job's own dirs and the system dirs voids the job. Deny rules miss `sh -c` forms (S1 smoke),
 * so this is the check that holds when they do.
 */
export function auditTranscript(text: string, roots: AuditRoots, cliResult?: unknown): AuditResult {
  const { uses, refused } = readCalls(text, cliResult);
  const violations: AuditFinding[] = [];
  const deniedAttempts: AuditFinding[] = [];
  for (const use of uses) {
    const hits = toolHits(use.name, use.input, roots);
    if (refused.has(use.id)) deniedAttempts.push({ line: use.line, tool: use.name, detail: JSON.stringify(use.input) });
    else violations.push(...hits.map((hit) => ({ line: use.line, tool: use.name, ...hit })));
  }
  return { contaminated: violations.length > 0, violations, deniedAttempts };
}

/** For any track's plugin: audits a finished job's transcript, or reports none when the job never wrote one. */
export function auditJob(transcriptPath: string, roots: AuditRoots, cliResult?: unknown): AuditResult | null {
  return existsSync(transcriptPath) ? auditTranscript(readFileSync(transcriptPath, "utf8"), roots, cliResult) : null;
}
