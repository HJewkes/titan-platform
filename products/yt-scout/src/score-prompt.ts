import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const SCORE_TEMPLATE_PATH = new URL("../prompts/score.v1.md", import.meta.url);

/** The rubric's two sections the score step keeps; its batch, file and `done` instructions do not apply to one video. */
const KEPT_SECTIONS = ["The owner's system", "Scores"];

export function extractRubric(rubric: string): string {
  const sections = rubric.split(/^(?=## )/m).filter((s) => KEPT_SECTIONS.some((name) => s.startsWith(`## ${name}`)));
  if (sections.length !== KEPT_SECTIONS.length) {
    throw new Error(`rubric is missing a required section: ${KEPT_SECTIONS.join(", ")}`);
  }
  return sections.map((s) => s.trim()).join("\n\n");
}

export interface ScorePrompt {
  prompt: string;
  promptSha: string;
  rubricSha: string;
  inputSha: string;
}

export interface ScorePromptInput {
  title: string;
  transcript: string;
  rubric: string;
  partial?: boolean;
  template?: string;
}

/** `prompt_sha` hashes the template file alone, so it moves only when the template does. */
export function buildScorePrompt(input: ScorePromptInput): ScorePrompt {
  const template = input.template ?? readFileSync(SCORE_TEMPLATE_PATH, "utf8");
  const rubric = extractRubric(input.rubric);
  const partialNote = input.partial ? "Note: this is a partial transcript (a long video); the caveat should say so.\n" : "";
  const prompt = template
    .replace("{{RUBRIC}}", () => rubric)
    .replace("{{TITLE}}", () => input.title)
    .replace("{{PARTIAL_NOTE}}", () => partialNote)
    .replace("{{TRANSCRIPT}}", () => input.transcript);
  return { prompt, promptSha: sha256(template), rubricSha: sha256(rubric), inputSha: sha256(input.transcript) };
}
