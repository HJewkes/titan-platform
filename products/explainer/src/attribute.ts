import { beatNumber } from "./storyboard.js";

/** One gate or check finding; only errors are attributed, since warnings never trigger a repair. */
export interface Finding {
  code: string;
  message: string;
  severity: "error" | "warning";
  selector?: string;
}

export interface Attribution {
  /** Beat id to its error findings, in finding order. */
  byBeat: Map<string, Finding[]>;
  /** Errors that name no known beat: these end the run rather than reach a repair worker. */
  unattributed: Finding[];
}

// Whole ids only: a `beat-3` that prefix-matched `beat-30` would send the repair to the wrong worker.
const BEAT_MENTION = /(?<![\w-])beat-(\d+)(?![\w])/g;

function mentionedNumbers(finding: Finding): number[] {
  const text = `${finding.selector ?? ""} ${finding.message}`;
  return [...text.matchAll(BEAT_MENTION)].map((m) => Number(m[1]));
}

/** Maps error findings to the beat each one names, by beat number, so `beat-03` and `beat-3` agree. */
export function attributeFindings(findings: readonly Finding[], beatIds: readonly string[]): Attribution {
  const idByNumber = new Map<number, string>();
  for (const id of beatIds) {
    const n = beatNumber(id);
    if (n !== undefined) idByNumber.set(n, id);
  }
  const byBeat = new Map<string, Finding[]>();
  const unattributed: Finding[] = [];
  for (const finding of findings) {
    if (finding.severity !== "error") continue;
    const id = mentionedNumbers(finding).map((n) => idByNumber.get(n)).find((x) => x !== undefined);
    if (id === undefined) unattributed.push(finding);
    else byBeat.set(id, [...(byBeat.get(id) ?? []), finding]);
  }
  return { byBeat, unattributed };
}
