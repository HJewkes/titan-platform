export interface HostileGlob {
  readonly name: string;
  readonly glob: string;
  /** A path of about `size` segments or characters that the glob does not match, so a backtracking matcher tries every split. */
  readonly path: (size: number) => string;
  /** The size from which every state of a linear matcher is live, so its work per character stops growing; `linearWork`'s `steady`. */
  readonly steady: number;
}

/**
 * The hostile rows of tp#2491 (TP-1756): `d/` and twenty `*` took 64 s on a 40-character path under the RegExp glob
 * compiler, and twelve `**\/` grow the same way. `separator` replaces `/` for a dialect that reads it as a literal or
 * refuses it, such as a round-id glob or a command word. Each row is `[name, row]`, for `it.each` with `%s`.
 */
export function hostileGlobs(separator = "/"): (readonly [string, HostileGlob])[] {
  const rows: HostileGlob[] = [
    { name: "d/ and 20 stars", glob: `d${separator}${"*".repeat(20)}x`, path: (size) => `d${separator}${"a".repeat(size)}`, steady: 1 },
    // Each segment can wake one more of the twelve globstars, until all are live.
    { name: "12 globstar segments", glob: `${`**${separator}`.repeat(12)}x`, path: (size) => `${`a${separator}`.repeat(size)}b`, steady: 16 },
  ];
  return rows.map((row) => [row.name, row] as const);
}
