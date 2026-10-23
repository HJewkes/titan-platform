import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";

interface PromptSlot {
  structure: string;
  system: string | null;
  blocks: { id: string; beats: string[] }[];
}

/** The slots a sampling prompt lists, read back from its `## Slots` section. */
export function promptSlots(prompt: string): PromptSlot[] {
  const section = prompt.split("## Slots\n\n")[1]!.split("\n\n## ")[0]!;
  return section.split("\n\n").map((text) => {
    const head = /^\d+\. structure (\S+), system (\S+) /.exec(text)!;
    const blocks = [...text.matchAll(/^ {3}- ([a-z0-9-]+): .*?(?: \(beats: ([^)]*)\))?$/gm)].map((m) => ({ id: m[1]!, beats: m[2]?.split(", ") ?? [] }));
    return { structure: head[1]!, system: head[2] === "none" ? null : head[2]!, blocks };
  });
}

/** The fact ids the prompt's `## Facts` section lists, whatever their shape (`F1`, `change:src/api.ts`). */
const factIds = (prompt: string): string[] => {
  const section = prompt.split("## Facts\n\n")[1]!.split("\n\n## ")[0]!;
  return [...section.matchAll(/^- (\S+?)(?: \[[^\]]*\])?: /gm)].map((m) => m[1]!);
};

/** A valid spine per slot: every fact on the hook block, the payoff on the second block, likelihoods falling by slot. */
function spinesFor(prompt: string, beatAt: (slot: number) => number) {
  const facts = factIds(prompt);
  return promptSlots(prompt).map((slot, i) => ({
    structure: slot.structure, system: slot.system, likelihood: Math.round((0.5 - i * 0.1) * 100) / 100,
    sentence: `Take ${i + 1}: the desk refuses ghost labels.`, hook: { fact: facts[0]!, line: `Take ${i + 1}: a parcel that does not exist.` },
    blocks: slot.blocks.map((block, b) => {
      const beat = block.beats[b === 0 ? 0 : beatAt(i) % block.beats.length] ?? "hook";
      return { id: block.id, question: `What happens at ${block.id}?`, facts: b === 0 ? facts : [facts[0]!], seconds: 30, beat, covers: [] };
    }),
    payoff: slot.blocks[1]!.id, signatureLayer: `layer ${i + 1}`, cuts: [],
  }));
}

interface FakeAuditionModel {
  runnerFor: (options: AgentRunnerOptions) => { run: (input: StepRunInput) => Promise<StepRunOutcome> };
  prompts: string[];
  budgets: number[];
}

/**
 * The sampling model: answers each prompt with one valid spine per slot, after `invalid` replies that cite an
 * unknown fact. `beatAt` picks each candidate's non-hook beats, so a test can set which one has the widest range.
 */
export function fakeAuditionModel(options: { invalid?: number; usd?: number; beatAt?: (slot: number) => number } = {}): FakeAuditionModel {
  const prompts: string[] = [];
  const budgets: number[] = [];
  let bad = options.invalid ?? 0;
  const usage = { costUsd: options.usd ?? 0.1, inputTokens: 2000, outputTokens: 900, cacheReadTokens: 0 };
  const runnerFor = (runner: AgentRunnerOptions) => ({
    run: async (input: StepRunInput): Promise<StepRunOutcome> => {
      prompts.push(input.prompt);
      budgets.push(runner.maxBudgetUsd);
      const spines = spinesFor(input.prompt, options.beatAt ?? (() => 0));
      const reply = bad-- > 0 ? spines.map((s) => ({ ...s, hook: { ...s.hook, fact: "F999" } })) : spines;
      return { ok: true, output: `\`\`\`json\n${JSON.stringify({ spines: reply })}\n\`\`\``, usage };
    },
  });
  return { runnerFor, prompts, budgets };
}
