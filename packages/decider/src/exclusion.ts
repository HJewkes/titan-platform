/**
 * The owner's exclusion data. The caller loads it from the charter and the owner overlay;
 * this package never reads either.
 */
export interface ExclusionPolicy {
  humanOnlyInitiatives: readonly string[];
  /** Project directories and the initiative each belongs to; the deepest match wins. */
  projectInitiatives: readonly { dir: string; initiative: string }[];
  /** A string matches as a case-insensitive whole word; a RegExp is used as given. */
  personalDataPatterns: readonly (string | RegExp)[];
}

export interface ExclusionSubject {
  initiative: string | null;
  cwd?: string | null;
  header: string | null;
  question: string;
  options: readonly { label: string }[];
  answer: string | null;
}

export type ExclusionReason = "human-only-initiative" | "human-only-cwd" | "personal-data";

export type ExclusionVerdict =
  | { excluded: true; reason: ExclusionReason }
  | { excluded: false; initiative: string | null; unclaimed: boolean };

function trimSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
}

function isUnder(cwd: string, dir: string): boolean {
  const base = trimSlash(dir);
  return cwd === base || cwd.startsWith(base === "/" ? "/" : `${base}/`);
}

/** The initiative a working directory belongs to, or null when no project directory holds it. */
export function initiativeForCwd(
  cwd: string | null | undefined,
  policy: Pick<ExclusionPolicy, "projectInitiatives">,
): string | null {
  if (!cwd) return null;
  const matches = policy.projectInitiatives.filter((p) => isUnder(trimSlash(cwd), p.dir));
  matches.sort((a, b) => trimSlash(b.dir).length - trimSlash(a.dir).length);
  return matches[0]?.initiative ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPattern(pattern: string | RegExp): RegExp {
  return typeof pattern === "string" ? new RegExp(`\\b${escapeRegExp(pattern)}\\b`, "i") : pattern;
}

function mentionsPersonalData(subject: ExclusionSubject, patterns: ExclusionPolicy["personalDataPatterns"]): boolean {
  const texts = [subject.header ?? "", subject.question, subject.answer ?? ""];
  const hay = [...texts, ...subject.options.map((o) => o.label)].join("\n");
  return patterns.some((p) => {
    const rx = toPattern(p);
    rx.lastIndex = 0;
    return rx.test(hay);
  });
}

/** Decide, before a row is written, whether it may enter the ledger and whether it is unclaimed. */
export function isExcluded(subject: ExclusionSubject, policy: ExclusionPolicy): ExclusionVerdict {
  const humanOnly = new Set(policy.humanOnlyInitiatives);
  if (subject.initiative !== null && humanOnly.has(subject.initiative)) {
    return { excluded: true, reason: "human-only-initiative" };
  }
  const fromCwd = initiativeForCwd(subject.cwd, policy);
  if (fromCwd !== null && humanOnly.has(fromCwd)) return { excluded: true, reason: "human-only-cwd" };
  if (mentionsPersonalData(subject, policy.personalDataPatterns)) {
    return { excluded: true, reason: "personal-data" };
  }
  const initiative = subject.initiative ?? fromCwd;
  return { excluded: false, initiative, unclaimed: initiative === null };
}
