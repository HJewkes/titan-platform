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
const SHAPES = [
  String.raw`gh[pousr](?:_|%5F)[A-Za-z0-9_]{20,}`,
  String.raw`github(?:_|%5F)pat(?:_|%5F)[A-Za-z0-9_]{20,}`,
  String.raw`${HEX}(?![0-9a-z_])(?<=${KEYWORD_START}(?:token|authorization|bearer)${GAP}*(?:(?:token|bearer)${GAP}+)?${HEX})`,
  String.raw`${HEX}(?=@|:[^\s/@]{0,255}@)(?<=[a-z][a-z0-9+.-]*://(?:[^\s/@:]*:)?${HEX})`,
  String.raw`${KEYWORD_START}eyJ[\w-]{10,}\.(?:eyJ[\w-]*|e30|[\w-]{10,})\.[\w-]{10,}`,
].join("|");
const TOKEN_SHAPE = new RegExp(SHAPES, "gi");
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
 * A token keyword ending `first` with the hex run in `second` (not necessarily at its start) is one token too.
 */
export function redactStreams(first: string, second: string, secrets: readonly string[]): [string, string] {
  const head = first.trimEnd();
  const rest = second.trimStart();
  const own = new Set(spansOf(rest).map((span) => span.start));
  const cuts = spansOf(head + rest).filter((span) => straddles(span, head, own));
  if (cuts.length === 0) return [redact(first, secrets), redact(second, secrets)];
  const inHead = cuts.filter((span) => span.start < head.length);
  const kept = inHead.length ? head.slice(0, Math.min(...inHead.map((span) => span.start))) : head;
  const lead = inHead.length ? 0 : Math.min(...cuts.map((span) => span.start)) - head.length;
  const tail = rest.slice(Math.max(...cuts.map((span) => span.end)) - head.length);
  return [redact(kept, secrets) + (inHead.length ? "[redacted]" : ""), redact(rest.slice(0, lead), secrets) + "[redacted]" + redact(tail, secrets)];
}

type Span = { start: number; end: number };

function spansOf(text: string): Span[] {
  return [...text.matchAll(TOKEN_SHAPE)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** A match crosses the seam, or sits wholly in `second` behind a keyword that ends `first` and that `second` alone would not match. */
function straddles(span: Span, head: string, ownStarts: ReadonlySet<number>): boolean {
  if (span.start < head.length) return span.end > head.length && !WHOLE_TOKEN.test(head.slice(span.start));
  return !ownStarts.has(span.start - head.length);
}
