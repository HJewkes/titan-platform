// GitHub token prefixes (ghs_, ghu_, gho_, ghp_, ghr_, github_pat_), raw or with the underscore URL-encoded as %5F;
// a classic 40-hex token right after a token keyword (GH_TOKEN counts: only a letter or digit before the keyword disqualifies
// it, and a percent-escape such as %26 does not) or as URL userinfo, alone or ahead of a `:password`; and the three-part
// base64url JWT, whose header always opens with `eyJ` and whose signature runs past ten characters, so a dotted file name
// such as `eyJsonwebtoken.config.js` is not one while a token with a short payload (`e30`) is.
// The hex run is matched first and the keyword or scheme is checked behind it, so a long run of whitespace or letters is
// scanned at most once per hex run rather than from every position; that is why the gap and the userinfo behind a hex run
// have no bound and nothing redacted before stays unredacted. Only the lookahead past a userinfo hex run is bounded
// (a 255-character password), because every hex run in a `hex:hex:hex:` chain would otherwise rescan the whole tail.
// A JWT payload is `eyJ...` (any JSON object), `e30` (`{}`), or any ten or more characters, as before.
const GAP = String.raw`(?:[\s"':=]|%(?:3[ad]|2[027]))`;
const KEYWORD_START = String.raw`(?:(?<![a-z0-9])|(?<=%[0-9a-f]{2}))`;
const HEX = "[0-9a-f]{40}";
const TOKEN_SHAPE = new RegExp(
  [
    String.raw`gh[pousr](?:_|%5F)[A-Za-z0-9_]{20,}`,
    String.raw`github(?:_|%5F)pat(?:_|%5F)[A-Za-z0-9_]{20,}`,
    String.raw`${HEX}(?![0-9a-z_])(?<=${KEYWORD_START}(?:token|authorization|bearer)${GAP}*(?:(?:token|bearer)${GAP}+)?${HEX})`,
    String.raw`${HEX}(?=@|:[^\s/@]{0,255}@)(?<=[a-z][a-z0-9+.-]*://(?:[^\s/@:]*:)?${HEX})`,
  ].join("|"),
  "gi",
);
// A JWT is found from the dot that ends its header, never from every `eyJ` in a run: a run such as `-eyJaaa-eyJaaa...`
// with no dot would otherwise be rescanned to its end from each `eyJ`. The header is the leftmost qualifying `eyJ` of the
// run behind that dot, captured by the lookbehind; the signature is captured by a lookahead, so the match itself stops at
// the payload's dot and a header there is still tried, as when the payload of one JWT is the header of the next.
const JWT_SEAM = new RegExp(String.raw`\.(?<=(${KEYWORD_START}eyJ[\w-]{10,})\.)(?:eyJ[\w-]*|e30|[\w-]{10,})(?=\.([\w-]{10,}))`, "gi");

type Span = { start: number; end: number };

/** Replaces every secret and every token-shaped string in `text`, so an error or log line built from `gh` output cannot leak one. */
export function redact(text: string, secrets: readonly string[]): string {
  const exact = secrets.filter((secret) => secret.length > 0).reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  let out = "";
  let at = 0;
  for (const span of spansOf(exact)) {
    out += exact.slice(at, span.start) + "[redacted]";
    at = span.end;
  }
  return out + exact.slice(at);
}

/**
 * Redacts two streams as one text, so a token split across them is cut from both halves. Trailing whitespace on `first`
 * and leading whitespace on `second` are ignored, since `gh` may end a stream mid-token with a newline. A match of the
 * joined text that neither stream matches alone at the same place is cut: one crossing the seam, even when `first` already
 * ends in a whole token (a token's length does not say it ended, so the first word of `second` may be cut with it), one in
 * `second` behind a keyword that ends `first`, and one in `first` that only `second` completes, as a userinfo `@`.
 */
export function redactStreams(first: string, second: string, secrets: readonly string[]): [string, string] {
  const head = first.trimEnd();
  const rest = second.trimStart();
  const seam = head.length;
  const ownHead = new Set(spansOf(head).map((span) => span.start));
  const ownRest = new Set(spansOf(rest).map((span) => span.start + seam));
  const isOwn = (span: Span): boolean => (span.end <= seam ? ownHead.has(span.start) : span.start >= seam && ownRest.has(span.start));
  const cuts = spansOf(head + rest).filter((span) => !isOwn(span));
  if (cuts.length === 0) return [redact(first, secrets), redact(second, secrets)];
  const inRest = cuts.filter((span) => span.end > seam).map((span) => ({ start: span.start - seam, end: span.end - seam }));
  return [cutHead(head, cuts, secrets), cutRest(rest, inRest, secrets)];
}

function cutHead(head: string, cuts: readonly Span[], secrets: readonly string[]): string {
  const start = cuts.reduce((least, span) => Math.min(least, span.start), head.length);
  return start < head.length ? redact(head.slice(0, start), secrets) + "[redacted]" : redact(head, secrets);
}

function cutRest(rest: string, cuts: readonly Span[], secrets: readonly string[]): string {
  if (cuts.length === 0) return redact(rest, secrets);
  const lead = cuts.reduce((least, span) => Math.min(least, Math.max(span.start, 0)), rest.length);
  const tail = cuts.reduce((most, span) => Math.max(most, span.end), 0);
  return redact(rest.slice(0, lead), secrets) + "[redacted]" + redact(rest.slice(tail), secrets);
}

/** Every token span in `text`, in order; a JWT that overlaps another shape is merged with it, so neither is left showing. */
function spansOf(text: string): Span[] {
  const shapes = [...text.matchAll(TOKEN_SHAPE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const jwts = [...text.matchAll(JWT_SEAM)].map((m) => ({ start: m.index - (m[1] ?? "").length, end: m.index + m[0].length + 1 + (m[2] ?? "").length }));
  const merged: Span[] = [];
  for (const span of [...shapes, ...jwts].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}
