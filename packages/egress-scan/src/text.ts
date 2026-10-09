import { locateRules, type TermRule } from "./rules.js";
import { toFinding, type Finding } from "./scan.js";

export interface TextOptions {
  readonly terms?: readonly TermRule[];
}

/** Scans free text and reports each hit as `line:col`; `\r\n`, `\n` and `\r` each count as one break. */
export function scanText(text: string, options: TextOptions = {}): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r\n|\n|\r/).forEach((line, i) => {
    for (const hit of locateRules(line, options.terms)) findings.push(toFinding(`${i + 1}:${hit.offset + 1}`, hit));
  });
  return findings;
}
