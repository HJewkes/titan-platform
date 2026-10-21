import type { NotEvent } from "./not-event.js";

interface A17Violation {
  readonly file: string;
  readonly title: string;
  readonly rule: string;
}

export interface A17Scan {
  readonly violations: readonly A17Violation[];
  /** A17 titles written without `a17Event`, whether or not the file is an event file. */
  readonly singleMode: readonly { file: string; title: string }[];
  readonly staleNotEvent: readonly NotEvent[];
  readonly notEvent: readonly NotEvent[];
}

// Matches the first string literal of it/test/describe, with any `.modifier` chain, so a skipped case is seen too.
const TITLE_CALL = /\b(?:it|test|describe)((?:\.\w+(?:\([^)]*\))?)*)\(\s*(["'`])((?:(?!\2).)*)\2/g;
const EVENT_IMPORT = /\bfrom\s+["'][^"']*(?:event-log\/|github-sources\/|ingress|reconciler)/;
const BANNED_MODIFIERS = new Set(["skip", "todo", "only", "skipIf", "runIf"]);

interface Title {
  readonly title: string;
  readonly modifiers: readonly string[];
}

function a17Titles(source: string): Title[] {
  return [...source.matchAll(TITLE_CALL)]
    .filter((match) => (match[3] ?? "").includes("A17:"))
    .map((match) => ({ title: match[3] ?? "", modifiers: [...(match[1] ?? "").matchAll(/\.(\w+)/g)].map((m) => m[1] ?? "") }));
}

/** Pure: scans `{ src-relative path: source }` for A17 cases that bypass `a17Event` or are skipped, todo'd or `.only`'d. */
export function scanA17(files: Readonly<Record<string, string>>, notEvent: readonly NotEvent[]): A17Scan {
  const violations: A17Violation[] = [];
  const singleMode: { file: string; title: string }[] = [];
  for (const [file, source] of Object.entries(files)) {
    const isEventFile = EVENT_IMPORT.test(source);
    for (const { title, modifiers } of a17Titles(source)) {
      for (const modifier of modifiers.filter((m) => BANNED_MODIFIERS.has(m))) violations.push({ file, title, rule: `modifier:${modifier}` });
      singleMode.push({ file, title });
      const listed = notEvent.some((entry) => entry.file === file && entry.title === title);
      if (isEventFile && !listed) violations.push({ file, title, rule: "unregistered-event" });
    }
  }
  const staleNotEvent = notEvent.filter((entry) => !singleMode.some((s) => s.file === entry.file && s.title === entry.title));
  return { violations, singleMode, staleNotEvent, notEvent };
}
