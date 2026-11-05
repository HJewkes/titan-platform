import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { plainText } from "@titan-design/speech-vet";

/** The chapter id the goal-walk structure gives its reflection block. */
const REFLECTION_CHAPTER = "reflection";

/** `deposit` files one owner-queue item per day; `retro-file` appends a dated retro file instead (plan Q4, a one-line switch). */
export const REFLECTION_MODES = ["deposit", "retro-file", "off"] as const;
export type ReflectionMode = (typeof REFLECTION_MODES)[number];

/** The slice of a script the reflection export reads. */
export interface ReflectionScript {
  beats: readonly { id: string; chapter: string; spoken: string; fact_ids: readonly string[] }[];
}

export interface ReflectionConfig {
  mode: ReflectionMode;
  /** The seat running the pipeline; it is the deposit's asker. */
  asker: string;
  /** Where deposits land; the real console spool is resolved by `ownerInboxDir`, never defaulted here. */
  spoolDir: string;
  /** Where `retro-file` writes `<day>-daily.md`. */
  retroDir?: string;
}

interface ReflectionRun {
  script: ReflectionScript;
  /** The raw script bytes' sha, so a re-run of the same script files nothing twice. */
  scriptSha: string;
  videoId: string;
  /** The day the digest covers, not the day the run happens; absent when the run has no digest day. */
  day: string | undefined;
  /** The run's export folder; `reflection.md` is written here. */
  outDir: string;
}

interface ReflectionResult {
  file: string;
  filed: "created" | "existing" | "none";
  notes: string[];
}

interface Proposal {
  beat: string;
  text: string;
  facts: readonly string[];
}

function reflectionProposals(script: ReflectionScript): Proposal[] {
  return script.beats
    .filter((beat) => beat.chapter === REFLECTION_CHAPTER)
    .map((beat) => ({ beat: beat.id, text: plainText(beat.spoken), facts: beat.fact_ids }));
}

function reflectionMarkdown(proposals: readonly Proposal[], day: string): string {
  const lines = proposals.map((p) => `- ${p.text}${p.facts.length > 0 ? ` (${p.facts.join(", ")})` : ""}`);
  return `# Reflection for ${day}\n\n${lines.join("\n")}\n`;
}

/** Keyed by video and script, so a re-run of an unchanged script reuses the same deposit name. */
const reflectionDepositId = (videoId: string, scriptSha: string): string =>
  `reflection-${createHash("sha256").update(JSON.stringify([videoId, scriptSha])).digest("hex").slice(0, 24)}`;

/** The deposit spool the titan console reads, as the factory resolves it. */
export function ownerInboxDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const expand = (value: string): string => (value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  if (env.TITAN_CONSOLE_INBOX_DIR) return expand(env.TITAN_CONSOLE_INBOX_DIR);
  return path.join(expand(env.TITAN_CONSOLE_STATE ?? "~/.local/state/titan-console"), "inbox", "deposits");
}

async function fileDeposit(config: ReflectionConfig, run: ReflectionRun & { day: string }, markdown: string): Promise<ReflectionResult["filed"]> {
  const result = await writeDeposit(config.spoolDir, {
    depositId: reflectionDepositId(run.videoId, run.scriptSha),
    asker: config.asker,
    kind: "review",
    door: "two-way",
    summary: `Daily reflection for ${run.day}: proposed changes to how we work`,
    context: markdown,
    keys: [`daily-reflection:${run.day}`],
  });
  return result.created ? "created" : "existing";
}

function fileRetro(config: ReflectionConfig, run: ReflectionRun & { day: string }, markdown: string): ReflectionResult["filed"] {
  const dir = config.retroDir;
  if (dir === undefined) throw new Error("retro-file mode needs a retroDir");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.day}-daily.md`);
  if (existsSync(file)) return "existing";
  writeFileSync(file, markdown, { flag: "wx" });
  return "created";
}

/**
 * Writes `reflection.md` beside the export and lands the proposals in the self-improvement loop once. A script with no
 * reflection chapter files nothing, and neither does a run with no digest day: a date guessed from the clock would key
 * the deposit to the wrong day. A filing failure is a note, never a failed export.
 */
export async function exportReflection(config: ReflectionConfig, run: ReflectionRun): Promise<ReflectionResult> {
  const proposals = reflectionProposals(run.script);
  const file = path.join(run.outDir, "reflection.md");
  if (config.mode === "off" || proposals.length === 0) return { file, filed: "none", notes: [] };
  const { day } = run;
  if (day === undefined) return { file, filed: "none", notes: ["reflection not filed: the run has no digest day"] };
  const markdown = reflectionMarkdown(proposals, day);
  mkdirSync(run.outDir, { recursive: true });
  writeFileSync(file, markdown);
  try {
    const filed = config.mode === "deposit" ? await fileDeposit(config, { ...run, day }, markdown) : fileRetro(config, { ...run, day }, markdown);
    return { file, filed, notes: [`reflection ${filed} (${config.mode})`] };
  } catch (error) {
    return { file, filed: "none", notes: [`reflection not filed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
