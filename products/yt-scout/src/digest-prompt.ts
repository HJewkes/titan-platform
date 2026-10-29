import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Retrieval } from "./digest-retrieval.js";
import type { ScoreCard } from "./score-card.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const DIGEST_TEMPLATE_PATH = new URL("../prompts/digest.v1.md", import.meta.url);

export interface DigestPrompt {
  prompt: string;
  promptSha: string;
  inputSha: string;
}

interface DigestPromptInput {
  title: string;
  transcript: string;
  card: ScoreCard;
  retrieval: Retrieval;
  partial?: boolean;
  template?: string;
}

const NONE = "(none found)";

function renderCard(card: ScoreCard): string {
  const techniques = card.techniques.map((t) => `- [${t.ts}] ${t.what}`).join("\n");
  return [`Summary: ${card.summary}`, `Pain points: ${card.pain_points.join(", ")}`, techniques ? `Techniques:\n${techniques}` : "", card.caveat ? `Caveat: ${card.caveat}` : ""]
    .filter(Boolean)
    .join("\n");
}

/** The order is part of the contract: passages as retrieval returned them, tasks sorted by id, so a replay renders the same text. */
function renderRetrieval(retrieval: Retrieval): { prior: string; tasks: string } {
  const prior = retrieval.priorDigests.map((p) => `- ${p}`).join("\n") || NONE;
  const tasks = [...retrieval.tasks].sort((a, b) => a.id.localeCompare(b.id)).map((t) => `- ${t.id}: ${t.title}`).join("\n") || NONE;
  return { prior, tasks };
}

/** `prompt_sha` hashes the template file alone, so it moves only when the template does. */
export function buildDigestPrompt(input: DigestPromptInput): DigestPrompt {
  const template = input.template ?? readFileSync(DIGEST_TEMPLATE_PATH, "utf8");
  const { prior, tasks } = renderRetrieval(input.retrieval);
  const partialNote = input.partial ? "Note: this is a partial transcript (a long video); say so in the summary.\n" : "";
  const prompt = template
    .replace("{{CARD}}", () => renderCard(input.card))
    .replace("{{PRIOR}}", () => prior)
    .replace("{{TASKS}}", () => tasks)
    .replace("{{TITLE}}", () => input.title)
    .replace("{{PARTIAL_NOTE}}", () => partialNote)
    .replace("{{TRANSCRIPT}}", () => input.transcript);
  return { prompt, promptSha: sha256(template), inputSha: sha256(input.transcript) };
}
