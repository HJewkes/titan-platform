import { createHash } from "node:crypto";

export interface PrefixSection {
  name: string;
  text: string;
}

export interface StablePrefixOptions {
  /** Refused in every section: a per-agent name makes the prefix unique per spawn. */
  agentName?: string;
}

export interface StablePrefix {
  text: string;
  hash: string;
}

export interface PrefixViolation {
  section: string;
  rule: string;
  match: string;
}

export class PrefixLintError extends Error {
  constructor(readonly violations: readonly PrefixViolation[]) {
    super(
      `stablePrefix refused: ${violations
        .map((v) => `${v.section} has ${v.rule} (${v.match})`)
        .join("; ")}`,
    );
    this.name = "PrefixLintError";
  }
}

const FORBIDDEN: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "worktree path", pattern: /\/\.worktrees\// },
  { rule: "ISO date", pattern: /\d{4}-\d{2}-\d{2}/ },
  { rule: "40-hex sha", pattern: /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/i },
  { rule: "<spawner> fill-in", pattern: /<spawner>/ },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rulesFor(options: StablePrefixOptions) {
  if (!options.agentName) return FORBIDDEN;
  const name = { rule: "agent name", pattern: new RegExp(escapeRegExp(options.agentName)) };
  return [name, ...FORBIDDEN];
}

export function lintPrefixSections(
  sections: readonly PrefixSection[],
  options: StablePrefixOptions = {},
): PrefixViolation[] {
  const rules = rulesFor(options);
  return sections.flatMap((section) =>
    rules.flatMap(({ rule, pattern }) => {
      const found = pattern.exec(`${section.name}\n${section.text}`);
      return found ? [{ section: section.name, rule, match: found[0] }] : [];
    }),
  );
}

/**
 * Joins sections in the order given (order is part of the cache key, so it is
 * never sorted) and hashes the result. Throws PrefixLintError on any per-spawn value.
 */
export function stablePrefix(
  sections: readonly PrefixSection[],
  options: StablePrefixOptions = {},
): StablePrefix {
  const violations = lintPrefixSections(sections, options);
  if (violations.length > 0) throw new PrefixLintError(violations);
  const text = sections.map((s) => `## ${s.name}\n\n${s.text.trim()}`).join("\n\n");
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}
