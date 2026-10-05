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
  return render(exact, spansOf(exact), (piece) => piece);
}

/**
 * Redacts two streams as one text, so a token split across them is cut from both halves. Trailing whitespace on `first`
 * and leading whitespace on `second` are ignored, since `gh` may end a stream mid-token with a newline. When the joined text
 * has a match that neither stream has alone at the same place (one crossing the seam, even when `first` already ends in a
 * whole token, since a token's length does not say it ended; one in `second` behind a keyword that ends `first`; one in
 * `first` that only `second` completes, as a userinfo `@`), every span of the joined text and of each stream alone is cut
 * from the stream it covers. The text between spans is still redacted, so nothing either stream matches alone shows.
 */
export function redactStreams(first: string, second: string, secrets: readonly string[]): [string, string] {
  const head = first.trimEnd();
  const rest = second.trimStart();
  const seam = head.length;
  const ownHead = spansOf(head);
  const ownRest = spansOf(rest).map((span) => ({ start: span.start + seam, end: span.end + seam }));
  const starts = new Set([...ownHead, ...ownRest].map((span) => span.start));
  const joined = spansOf(head + rest);
  if (joined.every((span) => (span.end <= seam || span.start >= seam) && starts.has(span.start))) return [redact(first, secrets), redact(second, secrets)];
  const spans = merged([...ownHead, ...ownRest, ...joined, ...secretSpans(head + rest, secrets)]);
  const piece = (text: string): string => redact(text, secrets);
  return [render(head, clip(spans, 0, seam), piece), render(rest, clip(spans, seam, seam + rest.length), piece)];
}

/** Each span of `text` becomes `[redacted]`; the text between spans goes through `piece`. */
function render(text: string, spans: readonly Span[], piece: (text: string) => string): string {
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += piece(text.slice(at, span.start)) + "[redacted]";
    at = span.end;
  }
  return out + piece(text.slice(at));
}

/** The part of each span inside `[from, to)`, counted from `from`. */
function clip(spans: readonly Span[], from: number, to: number): Span[] {
  return spans
    .map((span) => ({ start: Math.max(span.start, from) - from, end: Math.min(span.end, to) - from }))
    .filter((span) => span.start < span.end);
}

function secretSpans(text: string, secrets: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const secret of secrets.filter((value) => value.length > 0)) {
    for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) spans.push({ start: at, end: at + secret.length });
  }
  return spans;
}

/** Every token span in `text`, in order; a JWT that overlaps another shape is merged with it, so neither is left showing. */
function spansOf(text: string): Span[] {
  const shapes = [...text.matchAll(TOKEN_SHAPE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const jwts = [...text.matchAll(JWT_SEAM)].map((m) => ({ start: m.index - (m[1] ?? "").length, end: m.index + m[0].length + 1 + (m[2] ?? "").length }));
  return merged([...shapes, ...jwts]);
}

/** `spans` in order, with overlapping ones joined into one. */
function merged(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}
