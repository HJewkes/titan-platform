// GitHub token prefixes (ghs_, ghu_, gho_, ghp_, ghr_, github_pat_), raw or with the underscore URL-encoded as %5F;
// a classic 40-hex token right after a token keyword (GH_TOKEN counts: only a letter or digit before the keyword disqualifies
// it) or as URL userinfo; and the three-part base64url JWT, whose header always opens with `eyJ` and whose every part runs
// past ten characters, so a dotted file name such as `eyJsonwebtoken.config.js` is not one.
const SHAPES = [
  String.raw`gh[pousr](?:_|%5F)[A-Za-z0-9_]{20,}`,
  String.raw`github(?:_|%5F)pat(?:_|%5F)[A-Za-z0-9_]{20,}`,
  String.raw`(?<=(?<![a-z0-9])(?:token|authorization|bearer)[\s"':=]{0,5}(?:(?:token|bearer)\s+)?)[0-9a-f]{40}(?![0-9a-z_])`,
  String.raw`(?<=[a-z][a-z0-9+.-]*://(?:[^\s/@:]*:)?)[0-9a-f]{40}(?=@)`,
  String.raw`(?<![a-z0-9])eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}`,
].join("|");
const TOKEN_SHAPE = new RegExp(SHAPES, "gi");
const LEADING_TOKEN = new RegExp(`^(?:${SHAPES})`, "i");
const WHOLE_TOKEN = new RegExp(`^(?:${SHAPES})$`, "i");

/** Replaces every secret and every token-shaped string in `text`, so an error or log line built from `gh` output cannot leak one. */
export function redact(text: string, secrets: readonly string[]): string {
  const exact = secrets.filter((secret) => secret.length > 0).reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  return exact.replace(TOKEN_SHAPE, "[redacted]");
}

/**
 * Redacts two streams as one text, so a token split across them is cut from both halves. Trailing whitespace on `first`
 * and leading whitespace on `second` are ignored, since `gh` may end a stream mid-token with a newline. A head that is
 * already a whole token is redacted on its own, so a token ending `first` does not swallow the first word of `second`.
 * A token keyword ending `first` with the hex run opening `second` is one token too.
 */
export function redactStreams(first: string, second: string, secrets: readonly string[]): [string, string] {
  const head = first.trimEnd();
  const rest = second.trimStart();
  const spans = [...(head + rest).matchAll(TOKEN_SHAPE)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const cuts = spans.filter((span) => straddles(span, head, rest));
  if (cuts.length === 0) return [redact(first, secrets), redact(second, secrets)];
  const inHead = cuts.filter((span) => span.start < head.length);
  const kept = inHead.length ? head.slice(0, Math.min(...inHead.map((span) => span.start))) : head;
  const tail = rest.slice(Math.max(...cuts.map((span) => span.end)) - head.length);
  return [redact(kept, secrets) + (inHead.length ? "[redacted]" : ""), "[redacted]" + redact(tail, secrets)];
}

/** A match crosses the seam, or sits wholly in `second` behind a keyword that ends `first`. */
function straddles(span: { start: number; end: number }, head: string, rest: string): boolean {
  if (span.start < head.length) return span.end > head.length && !WHOLE_TOKEN.test(head.slice(span.start));
  return span.start === head.length && !LEADING_TOKEN.test(rest);
}
