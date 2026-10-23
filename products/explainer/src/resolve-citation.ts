import { lineSourceFromTexts, verifyRange, type LineSource } from "@titan-design/evidence";
import { z } from "zod";
import type { ResolveRefusal } from "./resolve-beat.js";
import type { ScriptBeat } from "./script-schema.js";

/** The `code` artifact: the cited files' text at the video's sha, by repo path. */
const CodeSourcesSchema = z.object({ files: z.record(z.string().min(1), z.string()) }).strict();

export const codeSource = (text: string): LineSource => lineSourceFromTexts(CodeSourcesSchema.parse(JSON.parse(text)).files);

type CodeBeat = Pick<ScriptBeat, "id" | "visual">;

function citationRefusal(beat: CodeBeat, source: LineSource | undefined): ResolveRefusal | undefined {
  const code = beat.visual.code;
  if (!code) return undefined;
  const refuse = (detail: string): ResolveRefusal => ({ beat: beat.id, code: "E-RESOLVE-CITATION", detail });
  if (!source) return refuse(`cites ${code.file} but the run has no code artifact to check it against`);
  const [lineStart, lineEnd] = code.lines;
  const range = verifyRange(source, { path: code.file, lineStart, lineEnd });
  if (!range.ok) return refuse(`${range.reason}: ${range.detail}`);
  const outside = code.highlight.filter((line) => line < lineStart || line > lineEnd);
  return outside.length > 0 ? refuse(`highlights line ${outside.join(", ")} outside ${code.file}:${lineStart}-${lineEnd}`) : undefined;
}

/**
 * Every code beat's citation checked against the cited file (`verifyRange`, the quote-free half of evidence's
 * `verifyCitation`: a script's code ref carries no quote). A missing file, a range past the end of the file, or a
 * highlight outside the range is refused before the stage writes anything.
 */
export function citationRefusals(beats: readonly CodeBeat[], source: LineSource | undefined): ResolveRefusal[] {
  return beats.flatMap((beat) => citationRefusal(beat, source) ?? []);
}
