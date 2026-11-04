import type { ScriptBeat } from "../script-schema.js";
import { factSource } from "./derive-cards.js";
import { itemReveals } from "./label-parse.js";
import type { BeatScope, Derivation, Reveal } from "./types.js";

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "shell",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
};

const languageOf = (path: string): string => LANGUAGES[path.slice(path.lastIndexOf(".") + 1)] ?? "text";

type Excerpt = { path: string; lines: { id: string; text: string }[]; reveals: Reveal[] };

/** The cited range's lines from the run's code source, ids `lines-<n>`. */
function excerpt(beat: ScriptBeat, scope: BeatScope): Excerpt | { reason: string } {
  const code = beat.visual.code;
  if (code === undefined) return { reason: "a code beat needs visual.code" };
  if (scope.code === undefined) return { reason: `${code.file} is cited but the fill has no code source` };
  const file = scope.code.lines(code.file);
  if (file === undefined) return { reason: `${code.file} is not in the code source` };
  const [from, to] = code.lines;
  const lines = file.slice(from - 1, to).map((text, i) => ({ id: `lines-${i + 1}`, text }));
  return { path: code.file, lines, reveals: itemReveals(beat, "lines", lines.length) };
}

export function deriveCodeWalk(beat: ScriptBeat, scope: BeatScope): Derivation {
  const found = excerpt(beat, scope);
  if ("reason" in found) return found;
  return { slots: { path: found.path, language: languageOf(found.path), mode: "plain", simplified: false, lines: found.lines }, reveals: found.reveals };
}

export function deriveFix(beat: ScriptBeat, scope: BeatScope): Derivation {
  const found = excerpt(beat, scope);
  return "reason" in found ? found : { slots: { path: found.path, lines: found.lines }, reveals: found.reveals };
}

/** The assertion is what the docs say, sourced by the first fact chip; the cited lines are what the code does. */
export function deriveDocsVsCode(beat: ScriptBeat, scope: BeatScope): Derivation {
  const found = excerpt(beat, scope);
  if ("reason" in found) return found;
  const source = factSource(beat);
  if (source === undefined) return { reason: "docs-vs-code needs a chip with a fact id as the docs' source" };
  return { slots: { docs: beat.visual.assertion, source, path: found.path, lines: found.lines }, reveals: found.reveals };
}
