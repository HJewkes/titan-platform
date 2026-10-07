/**
 * How a partition picks the anchor line of a blob: the first line matching
 * `rules` (tried in rule order) is anchored; otherwise `fallback` picks a
 * positional line, which is unanchored.
 */
export interface AnchorConfig {
  rules: readonly RegExp[];
  fallback: 'first-line' | 'last-non-blank';
}

/** Frozen anchor configs keyed by partition; unregistered partitions fall back to `generic`. */
export type AnchorConfigs = Readonly<Record<string, AnchorConfig>>;

const BASH_ANCHOR_RULES: readonly RegExp[] = [
  // Native shell diagnostics are not necessarily prefixed with an Error class.
  /^[^\s:]+: .+: (?:No such file or directory|Permission denied|Not a directory|Is a directory)\s*$/i,
  /^\w*Error\b.*$/,
  /^\s*at\s.*$/,
  /exit (?:code|status)[: ]+\d+/i,
];

const TEST_RUNNER_ANCHOR_RULES: readonly RegExp[] = [
  /\d+\s+passed.*\d+\s+failed/i,
  /\d+\s+failed.*\d+\s+passed/i,
  /error TS\d+:.*$/,
  /^\s*✖?\s*[\w-]+\/[\w-]+(?:\/[\w-]+)*\s*$/, // eslint-style rule id, e.g. no-unused-vars
];

/**
 * `git` anchors on its first line, `test` tries test-runner shapes (pass/fail
 * counts, `error TS…`, eslint rule ids) before the shell ones, and every other
 * partition uses `generic`: shell diagnostics, then the last non-blank line.
 */
export const DEFAULT_ANCHOR_CONFIGS: AnchorConfigs = Object.freeze({
  generic: Object.freeze({ rules: BASH_ANCHOR_RULES, fallback: 'last-non-blank' }),
  test: Object.freeze({ rules: [...TEST_RUNNER_ANCHOR_RULES, ...BASH_ANCHOR_RULES], fallback: 'last-non-blank' }),
  git: Object.freeze({ rules: [], fallback: 'first-line' }),
});

export interface Anchor {
  line: string;
  anchored: boolean;
}

function firstMatch(lines: string[], rules: readonly RegExp[]): string | undefined {
  for (const rule of rules) {
    const line = lines.find((l) => rule.test(l));
    if (line !== undefined) return line.trim();
  }
  return undefined;
}

function lastNonBlank(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim().length > 0) return line.trim();
  }
  return '';
}

const NO_RULES: AnchorConfig = { rules: [], fallback: 'last-non-blank' };

export function anchorFor(partition: string, lines: string[], configs: AnchorConfigs): Anchor {
  const config = configs[partition] ?? configs.generic ?? NO_RULES;
  const match = firstMatch(lines, config.rules);
  if (match !== undefined) return { line: match, anchored: true };
  const line = config.fallback === 'first-line' ? (lines[0] ?? '').trim() : lastNonBlank(lines);
  return { line, anchored: false };
}
