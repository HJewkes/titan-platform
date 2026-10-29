import { dataFence } from "../fence.js";
import { planSliceExcerpt, touchPointsIn, type TouchPoint } from "./plan-slice.js";
import {
  gitStateBody,
  readinessBody,
  taskCardBody,
  touchPointExcerpts,
  type BootReaders,
  type ReadinessFacts,
} from "./sections.js";

export type BootSectionId = "git" | "task" | "plan" | "touchPoints" | "readiness";

export interface BootPacketInput {
  task: { id: string };
  /** The plan file and the slice id whose part of it the agent needs. */
  plan?: { path: string; slice: string };
  repo: ReadinessFacts;
  /** Files to excerpt; defaults to the backticked paths in the plan slice. */
  touchPoints?: TouchPoint[];
  readers: BootReaders;
  options?: BootPacketOptions;
}

export interface BootPacketOptions {
  /** Whole-packet budget in tokens. */
  budget?: number;
  /** Per-section caps in tokens; a section over its cap loses lines, or whole excerpts, from its end. */
  caps?: Partial<Record<BootSectionId, number>>;
  /** Sections to include, most important first; over budget, whole sections drop from the end. */
  priority?: BootSectionId[];
  maxTouchPoints?: number;
  /** Token counter for the budget; the default estimates from characters. */
  countTokens?: (text: string) => number;
}

export interface BootSection {
  id: BootSectionId;
  title: string;
  text: string;
  tokens: number;
  truncated: boolean;
}

export interface BootPacket {
  text: string;
  tokens: number;
  sections: BootSection[];
  /** Sections left out, with why: no source, or dropped to fit the budget. */
  omitted: Array<{ id: BootSectionId; reason: string }>;
}

export const BOOT_PACKET_BUDGET = 6000;
export const DEFAULT_BOOT_PRIORITY: readonly BootSectionId[] = ["git", "task", "plan", "touchPoints", "readiness"];
const DEFAULT_CAPS: Record<BootSectionId, number> = { git: 600, task: 800, plan: 1500, touchPoints: 2500, readiness: 600 };
const CHARS_PER_TOKEN = 4;

/** About four characters a token for English and code; a real tokenizer can be passed in instead. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** A section before capping: its parts are the units truncation drops, `wrap` fences the kept ones. */
interface Draft {
  id: BootSectionId;
  title: string;
  parts: string[];
  separator: string;
  wrap?: (body: string) => string;
}
type Missing = { id: BootSectionId; missing: string };

const lines = (text: string): string[] => text.split("\n");

function draftGit(input: BootPacketInput): Draft | Missing {
  const git = input.readers.gitState(input.task.id);
  if (git === null) return { id: "git", missing: "git state unreadable" };
  const title = `Git state (captured ${git.capturedAt}; run your own git fetch before relying on it)`;
  return { id: "git", title, parts: lines(gitStateBody(git)), separator: "\n" };
}

function draftTask(input: BootPacketInput): Draft | Missing {
  const task = input.readers.readTask(input.task.id);
  if (task === null) return { id: "task", missing: `task ${input.task.id} not found` };
  return { id: "task", title: "Task card", parts: lines(taskCardBody(task)), separator: "\n" };
}

function sliceText(input: BootPacketInput): string | null {
  if (input.plan === undefined) return null;
  const plan = input.readers.readFile(input.plan.path);
  return plan === null ? null : planSliceExcerpt(plan, input.plan.slice);
}

function draftPlan(input: BootPacketInput, slice: string | null): Draft | Missing {
  if (slice === null) return { id: "plan", missing: "no plan file or no slice in it" };
  const title = `Plan slice ${input.plan?.slice ?? ""}`;
  return { id: "plan", title, parts: lines(slice), separator: "\n", wrap: (b) => dataFence("plan", b) };
}

function draftTouchPoints(input: BootPacketInput, points: TouchPoint[]): Draft | Missing {
  const parts = touchPointExcerpts(points, input.readers);
  if (parts.length === 0) return { id: "touchPoints", missing: "no readable touch points" };
  return { id: "touchPoints", title: "Touch points", parts, separator: "\n\n" };
}

function drafts(input: BootPacketInput, wanted: readonly BootSectionId[]): Array<Draft | Missing> {
  const slice = sliceText(input);
  const points = input.touchPoints ?? touchPointsIn(slice ?? "", input.options?.maxTouchPoints ?? 8);
  const build: Record<BootSectionId, () => Draft | Missing> = {
    git: () => draftGit(input),
    task: () => draftTask(input),
    plan: () => draftPlan(input, slice),
    touchPoints: () => draftTouchPoints(input, points),
    readiness: () => ({
      id: "readiness",
      title: "Readiness",
      parts: lines(readinessBody(points, input.repo, input.readers)),
      separator: "\n",
    }),
  };
  return wanted.map((id) => build[id]());
}

function render(d: Draft, parts: string[], note: string): string {
  const body = parts.join(d.separator);
  return `## ${d.title}\n${d.wrap === undefined ? body : d.wrap(body)}${note}`;
}

/** Drops whole parts from the end until the section fits its cap, and says so in the text. */
function capSection(d: Draft, cap: number, count: (t: string) => number): BootSection {
  const parts = [...d.parts];
  let text = render(d, parts, "");
  const truncated = count(text) > cap;
  while (count(text) > cap && parts.length > 0) {
    parts.pop();
    text = render(d, parts, `\n[truncated to fit ${cap} tokens]`);
  }
  return { id: d.id, title: d.title, text, tokens: count(text), truncated };
}

function fitBudget(sections: BootSection[], header: string, budget: number, count: (t: string) => number) {
  const kept = [...sections];
  const dropped: BootSection[] = [];
  const join = (): string => [header, ...kept.map((s) => s.text)].join("\n\n");
  for (let last = kept.at(-1); last !== undefined && count(join()) > budget; last = kept.at(-1)) {
    dropped.unshift(last);
    kept.pop();
  }
  return { kept, dropped, text: join() };
}

/**
 * The boot packet for an implementer: what the spawner already knows about the task's state, cut to a
 * token budget so it can ride in the first turn. Every read goes through `input.readers`.
 */
export function bootPacket(input: BootPacketInput): BootPacket {
  const opts = input.options ?? {};
  const count = opts.countTokens ?? estimateTokens;
  const caps = { ...DEFAULT_CAPS, ...opts.caps };
  const omitted: BootPacket["omitted"] = [];
  const sections: BootSection[] = [];
  for (const d of drafts(input, opts.priority ?? DEFAULT_BOOT_PRIORITY)) {
    if ("missing" in d) omitted.push({ id: d.id, reason: d.missing });
    else sections.push(capSection(d, caps[d.id], count));
  }
  const fit = fitBudget(sections, `# Boot packet for ${input.task.id}`, opts.budget ?? BOOT_PACKET_BUDGET, count);
  for (const s of fit.dropped) omitted.push({ id: s.id, reason: "dropped to fit the budget" });
  return { text: fit.text, tokens: count(fit.text), sections: fit.kept, omitted };
}
