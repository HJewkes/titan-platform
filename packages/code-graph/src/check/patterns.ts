/** Glob when the pattern has a `*` (`**` crosses directories, `*` stays in a segment); otherwise a case-sensitive substring. */
export function patternToRegex(pattern: string): RegExp {
  if (!pattern.includes("*")) {
    return new RegExp(escapeRegex(pattern));
  }
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else {
      out += escapeRegex(c);
    }
  }
  return new RegExp(`^${out}$`);
}

export function compilePatterns(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns) return [];
  return patterns.map(patternToRegex);
}

export function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  for (const rx of patterns) {
    if (rx.test(value)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?(){}|^$\\[\]]/g, "\\$&");
}
