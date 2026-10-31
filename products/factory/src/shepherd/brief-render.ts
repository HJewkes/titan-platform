/** Turns the facts `shepherd brief` read into the owner section, as markdown or as the review harness's round@2 section and question. */
import type { BriefFacts } from "./brief-inputs.js";
import { buildOwnerSection, type OwnerSectionInput } from "./owner-section.js";
import { pairVisuals } from "./visuals-manifest.js";

export const BRIEF_FORMATS = ["md", "round-section"] as const;
type BriefFormat = (typeof BRIEF_FORMATS)[number];

type Built = ReturnType<typeof buildOwnerSection>;

export type BriefOutput = { format: "md"; markdown: string } | { format: "round-section"; section: Built["section"]; question: Built["question"] };

interface BriefTask {
  title: string;
  done_when: string;
}

export interface RenderPorts {
  /** `slug` and `id` of the registration's task; a throw reads as an unreadable task, never a failed brief. */
  readTask: (slug: string, id: string) => Promise<BriefTask>;
  now: () => number;
}

const DAY_MS = 86_400_000;

/** The body's Summary section, the implementer's own description, up to the next heading. */
export function summaryOf(body: string): string | undefined {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s*summary\s*$/i.test(line.trim()));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  const text = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return text === "" ? undefined : text;
}

async function taskLine(task: string, readTask: RenderPorts["readTask"]): Promise<string> {
  const [slug = "", id = ""] = task.split("/");
  try {
    const read = await readTask(slug, id);
    return `Task ${id}: ${read.title}. Done when: ${read.done_when}`;
  } catch (error) {
    return `Task ${id} is unreadable: ${error instanceof Error ? error.message : String(error)}.`;
  }
}

async function visualsOf(facts: BriefFacts, images: string | undefined): Promise<OwnerSectionInput["visuals"]> {
  return facts.ui && images !== undefined ? pairVisuals(images, facts.pr, facts.head) : undefined;
}

async function sectionInput(facts: BriefFacts, options: { images?: string }, ports: RenderPorts): Promise<OwnerSectionInput> {
  const summary = [summaryOf(facts.body), await taskLine(facts.task, ports.readTask)].filter((part) => part !== undefined).join("\n\n");
  const visuals = await visualsOf(facts, options.images);
  return {
    pr: {
      repo: facts.repo,
      number: facts.pr,
      url: facts.url,
      title: facts.title,
      head: facts.head,
      summary,
      additions: facts.additions,
      deletions: facts.deletions,
      changedFiles: facts.changedFiles,
      ci: facts.ci,
      openDays: Math.max(0, Math.floor((ports.now() - Date.parse(facts.trackedSince)) / DAY_MS)),
      ui: facts.ui,
    },
    taskId: facts.task.split("/").at(-1),
    ...(facts.ownerGateReason && { ownerGateReason: facts.ownerGateReason }),
    gate: facts.gate,
    ...(facts.verdict && { verdict: facts.verdict }),
    ...(visuals && { visuals }),
  };
}

export async function renderBrief(facts: BriefFacts, options: { format: BriefFormat; images?: string }, ports: RenderPorts): Promise<BriefOutput> {
  const { markdown, section, question } = buildOwnerSection(await sectionInput(facts, options, ports));
  return options.format === "md" ? { format: "md", markdown } : { format: "round-section", section, question };
}
