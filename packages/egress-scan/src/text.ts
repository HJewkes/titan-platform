import { locateRules, type TermRule } from "./rules.js";
import type { Finding } from "./scan.js";

export interface TextOptions {
  readonly terms?: readonly TermRule[];
}

/** Scans free text and reports each hit as `line:col`; `\r\n`, `\n` and `\r` each count as one break. */
export function scanText(text: string, options: TextOptions = {}): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r\n|\n|\r/).forEach((line, i) => {
    for (const { rule, termIndex, offset } of locateRules(line, options.terms)) {
      const location = `${i + 1}:${offset + 1}`;
      findings.push(termIndex === undefined ? { location, rule } : { location, rule, termIndex });
    }
  });
  return findings;
}
