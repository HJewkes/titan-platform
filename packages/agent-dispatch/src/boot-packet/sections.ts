import { dataFence } from "../fence.js";
import type { TouchPoint } from "./plan-slice.js";

export interface GitState {
  /** ISO time the state was read; the packet labels the section with it because it goes stale. */
  capturedAt: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  /** One-line commits on HEAD that the base lacks. */
  ahead: string[];
  /** One-line base commits whose message names the task id. */
  landed: string[];
  /** Open pull requests naming the task id, when the reader can see them. */
  openPrs?: string[];
}

export interface TaskCard {
  id: string;
  title?: string;
  status?: string;
  estimate?: string | number;
  doneWhen?: string[];
  notes?: string[];
}

/** Everything the packet reads, injected so the builder itself does no I/O. */
export interface BootReaders {
  /** A file's text, or null when it is missing or unreadable. Relative paths resolve against the repo root. */
  readFile(path: string): string | null;
  exists(path: string): boolean;
  gitState(taskId: string): GitState | null;
  readTask(taskId: string): TaskCard | null;
}

const EXCERPT_RADIUS = 15;

function list(items: readonly string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

export function gitStateBody(git: GitState): string {
  const lines = [
    `Base: ${git.baseRef} ${git.baseSha}`,
    `HEAD: ${git.headSha}`,
    `${git.baseRef}..HEAD: ${git.ahead.length === 0 ? "none" : `\n${list(git.ahead)}`}`,
    `Base commits naming the task: ${git.landed.length === 0 ? "none" : `\n${list(git.landed)}`}`,
  ];
  if (git.openPrs !== undefined) {
    lines.push(`Open PRs naming the task: ${git.openPrs.length === 0 ? "none" : `\n${list(git.openPrs)}`}`);
  }
  return lines.join("\n");
}

export function taskCardBody(task: TaskCard): string {
  const lines = [`${task.id}${task.title === undefined ? "" : `: ${task.title}`}`];
  if (task.status !== undefined) lines.push(`Status: ${task.status}`);
  if (task.estimate !== undefined) lines.push(`Estimate: ${task.estimate}`);
  if (task.doneWhen !== undefined && task.doneWhen.length > 0) lines.push(`Done when:\n${list(task.doneWhen)}`);
  if (task.notes !== undefined && task.notes.length > 0) lines.push(`Notes:\n${list(task.notes)}`);
  return lines.join("\n");
}

function excerpt(text: string, line: number | undefined): { from: number; body: string } {
  const lines = text.split(/\r?\n/);
  const centre = line ?? 1;
  const from = Math.max(1, centre - EXCERPT_RADIUS);
  const to = Math.min(lines.length, centre + EXCERPT_RADIUS);
  return { from, body: lines.slice(from - 1, to).join("\n") };
}

/** One fenced excerpt per readable file, kept apart so truncation drops whole excerpts. */
export function touchPointExcerpts(points: readonly TouchPoint[], readers: BootReaders): string[] {
  return points.flatMap((p) => {
    const text = readers.readFile(p.path);
    if (text === null) return [];
    const { from, body } = excerpt(text, p.line);
    return [`### ${p.path}:${from}\n${dataFence("excerpt", body)}`];
  });
}

export interface ReadinessFacts {
  /** The command the repo wants run before a push, when the caller knows it. */
  verify?: string;
}

const LOCKFILES: ReadonlyArray<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
];

function verifyScripts(readers: BootReaders): string[] {
  const text = readers.readFile("package.json");
  if (text === null) return [];
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
    return ["verify:changed", "build", "typecheck", "lint", "test"].filter((s) => s in scripts);
  } catch {
    return [];
  }
}

function capabilityRows(points: readonly TouchPoint[], readers: BootReaders): string[] {
  const catalog = readers.readFile("CAPABILITIES.md");
  if (catalog === null) return [];
  const names = new Set(points.flatMap((p) => /^packages\/([^/]+)\//.exec(p.path)?.[1] ?? []));
  const rows = catalog.split(/\r?\n/);
  return [...names].flatMap((n) => rows.find((r) => r.startsWith(`| [\`${n}\`]`)) ?? []);
}

export function readinessBody(points: readonly TouchPoint[], facts: ReadinessFacts, readers: BootReaders): string {
  const install = LOCKFILES.find(([file]) => readers.exists(file))?.[1];
  const scripts = verifyScripts(readers);
  const lines = [`node_modules: ${readers.exists("node_modules") ? "present" : "absent"}`];
  if (install !== undefined) lines.push(`Install: ${install}`);
  if (facts.verify !== undefined) lines.push(`Verify: ${facts.verify}`);
  else if (scripts.length > 0) lines.push(`Scripts: ${scripts.join(", ")}`);
  const rows = capabilityRows(points, readers);
  if (rows.length > 0) lines.push(`CAPABILITIES rows:\n${rows.join("\n")}`);
  return lines.join("\n");
}
