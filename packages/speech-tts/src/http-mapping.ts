import { isRecord } from "@titan-design/rpc-protocol/narrow";
import type { SynthesizeOptions, TtsInput } from "./types.js";

/**
 * The values a request template may name: `{{text}}`, `{{voice}}`, `{{speed}}`, `{{language}}`, `{{alphabet}}`,
 * `{{tokens}}`, and `{{phonemes}}` (each token's phonemes, or its text when it has none, joined by its whitespace).
 */
export type TemplateValues = Record<string, unknown>;

const WHOLE = /^\{\{(\w+)\}\}$/;
const INLINE = /\{\{(\w+)\}\}/g;
const DROP = Symbol("drop");

export function templateValues(input: TtsInput, voice: string, options: SynthesizeOptions): TemplateValues {
  const base = { voice, speed: options.speed, language: options.language };
  if (!("tokens" in input)) return { ...base, text: input.text };
  const text = input.tokens.map((t) => t.text + (t.whitespace ?? " ")).join("").trim();
  const phonemes = input.tokens.map((t) => (t.phonemes ?? t.text) + (t.whitespace ?? " ")).join("").trim();
  return { ...base, text, phonemes, tokens: input.tokens, alphabet: input.alphabet };
}

function fillValue(template: unknown, values: TemplateValues): unknown {
  if (typeof template === "string") {
    const whole = WHOLE.exec(template);
    // A whole-string placeholder keeps the value's type (speed stays a number) and drops its key when unset.
    if (whole) return values[whole[1] ?? ""] ?? DROP;
    return template.replace(INLINE, (_, name: string) => String(values[name] ?? ""));
  }
  if (Array.isArray(template)) return template.map((item) => fillValue(item, values)).filter((item) => item !== DROP);
  if (isRecord(template)) {
    const entries = Object.entries(template).map(([key, value]) => [key, fillValue(value, values)] as const);
    return Object.fromEntries(entries.filter(([, value]) => value !== DROP));
  }
  return template;
}

/** Fills a JSON request template. Unknown placeholders are treated as unset. */
export function fillTemplate(template: unknown, values: TemplateValues): unknown {
  const filled = fillValue(template, values);
  return filled === DROP ? null : filled;
}

/** Reads `a.b.0.c` from parsed JSON; undefined when any step is missing. */
export function readPath(doc: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (Array.isArray(node)) return node[Number(key)] as unknown;
    return isRecord(node) ? node[key] : undefined;
  }, doc);
}
