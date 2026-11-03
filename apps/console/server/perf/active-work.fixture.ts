// A synthetic active-work workspace at the size the console's audit measured (TP-4403 §3d). Nothing is copied from a real one.
import { DELIVERABLE_STATUSES } from "@titan-design/pm";
import type { WireDeliverable, WireInitiative, WireTask } from "../active-work.js";
import { draw, isoAt, pad, WORDS, type Draw } from "./random.fixture.js";

export const AW_SIZES = { initiatives: 45, tasksPerInitiative: 200, notesPerInitiative: 34, sourcesPerInitiative: 34, repos: 30, deliverables: 24 } as const;

const STATES = ["focused", "backburner", "paused", "done"] as const;
const TAGS = ["transport", "docs", "perf", "ui", "infra", "security", "tests", "release"] as const;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const NOTE_KINDS = ["decision", "gotcha", "plan", "fyi"] as const;
const SOURCE_TYPES = ["deepdive", "pr", "pointer", "research"] as const;
/** Three of 45 are personal, which every work read must keep out. */
const PERSONAL_EVERY = 15;

export interface AwNote {
  id: string;
  slug: string;
  filename: string;
  path: string;
  kind: string;
  title: string;
  created: string;
  mtime: string;
}

export interface AwSource {
  id: string;
  slug: string;
  filename: string;
  path: string;
  type: string;
  title: string;
  nested: boolean;
  mtime: string;
}

export interface AwArtifacts {
  slug: string;
  artifacts: { branches: { repo: string; name: string }[]; worktrees: { path: string; repo: string; branch: string }[] };
}

export interface ActiveWorkState {
  initiatives: (WireInitiative & { prefix: string; personal: boolean })[];
  tasks: WireTask[];
  notes: AwNote[];
  sources: AwSource[];
  artifacts: AwArtifacts[];
  deliverables: WireDeliverable[];
}

const prefixOf = (index: number): string => String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26));

function initiatives(random: Draw): ActiveWorkState["initiatives"] {
  return Array.from({ length: AW_SIZES.initiatives }, (_, index) => {
    const word = WORDS[index % WORDS.length]!;
    const state = index < 6 ? "focused" : random.pick(STATES);
    return {
      slug: `${word}-${pad(index, 2)}`,
      title: `${word[0]!.toUpperCase()}${word.slice(1)} ${index}: synthetic initiative`,
      state,
      ...(state === "focused" && { rank: index + 1 }),
      updated: isoAt(-random.int(2000)).slice(0, 10),
      prefix: prefixOf(index),
      personal: index % PERSONAL_EVERY === PERSONAL_EVERY - 1,
    };
  });
}

/** Parent and dep edges point only at earlier tasks of the same initiative, so the graph has no cycle. */
function tasksOf(random: Draw, slug: string, prefix: string): WireTask[] {
  const ids: string[] = [];
  return Array.from({ length: AW_SIZES.tasksPerInitiative }, (_, index) => {
    const id = `${prefix}-${index + 1}`;
    const earlier = ids.slice(-40);
    ids.push(id);
    const done = random.chance(0.3);
    const tags = random.some(TAGS, 3);
    const parent = earlier.length > 0 && random.chance(0.2) ? random.pick(earlier) : undefined;
    const dep = earlier.length > 0 && random.chance(0.15) ? random.some(earlier, 2) : [];
    return {
      slug,
      id,
      title: `${random.pick(WORDS)} ${random.pick(TAGS)} task ${index + 1} for ${slug}`,
      priority: 1 + random.int(4),
      severity: random.pick(SEVERITIES),
      ...(random.chance(0.6) && { estimate: 1 + random.int(5) }),
      ...(tags.length > 0 && { tags }),
      ...(parent !== undefined && { parent }),
      ...(dep.length > 0 && { dep }),
      status: done ? "done" : "open",
      ...(random.chance(0.5) && { notes: `Synthetic note on ${id}: ${"lorem ".repeat(1 + random.int(20)).trim()}` }),
      done_when: `${id} is measured and merged`,
      updated: isoAt(-random.int(4000)).slice(0, 10),
    };
  });
}

function notesOf(random: Draw, slug: string): AwNote[] {
  return Array.from({ length: AW_SIZES.notesPerInitiative }, (_, index) => {
    const hours = -random.int(6000);
    const filename = `${isoAt(hours).slice(0, 10)}-${random.pick(WORDS)}-${pad(index, 3)}.md`;
    const path = `/synthetic/${slug}/sources/notes/${filename}`;
    return { id: `${slug}:notes:${filename}`, slug, filename, path, kind: random.pick(NOTE_KINDS), title: `${random.pick(WORDS)} note ${index} on ${slug}`, created: isoAt(hours).slice(0, 10), mtime: isoAt(hours) };
  });
}

function sourcesOf(random: Draw, slug: string): AwSource[] {
  return Array.from({ length: AW_SIZES.sourcesPerInitiative }, (_, index) => {
    const nested = random.chance(0.2);
    const type = random.pick(SOURCE_TYPES);
    const filename = `${nested ? "captures/" : ""}${type}-${random.pick(WORDS)}-${pad(index, 3)}.md`;
    return { id: `${slug}:sources:${filename}`, slug, filename, path: `/synthetic/${slug}/sources/${filename}`, type, title: `${type} ${index} for ${slug}`, nested, mtime: isoAt(-random.int(6000)) };
  });
}

function artifactsOf(random: Draw, slug: string, tasks: readonly WireTask[]): AwArtifacts {
  const repo = (): string => `example-org/repo-${pad(random.int(AW_SIZES.repos), 2)}`;
  const branches = random.some(tasks, 4).map((task) => ({ repo: repo(), name: `feat/${task.id.toLowerCase()}` }));
  const worktrees = branches.slice(0, 1).map((branch) => ({ path: `/synthetic/worktrees/${branch.name.replace("/", "-")}`, repo: branch.repo, branch: branch.name }));
  return { slug, artifacts: { branches, worktrees } };
}

function deliverables(random: Draw): WireDeliverable[] {
  return Array.from({ length: AW_SIZES.deliverables }, (_, index) => ({
    id: `DL-${index + 1}`,
    title: `Deliverable ${index + 1}`,
    status: random.pick(DELIVERABLE_STATUSES),
    target: random.chance(0.5) ? isoAt(random.int(4000)).slice(0, 10) : null,
    owner_seat: `seat-${random.int(6)}`,
    tags: random.some(TAGS, 2),
    tasks: { open: random.int(30), done: random.int(30) },
  }));
}

export function activeWorkState(seed: string): ActiveWorkState {
  const random = draw(`${seed}:active-work`);
  const list = initiatives(random);
  const tasks = list.flatMap(({ slug, prefix }) => tasksOf(random, slug, prefix));
  const tasksOfSlug = (slug: string): WireTask[] => tasks.filter((task) => task.slug === slug);
  return {
    initiatives: list,
    tasks,
    notes: list.flatMap(({ slug }) => notesOf(random, slug)),
    sources: list.flatMap(({ slug }) => sourcesOf(random, slug)),
    artifacts: list.map(({ slug }) => artifactsOf(random, slug, tasksOfSlug(slug))),
    deliverables: deliverables(random),
  };
}
