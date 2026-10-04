// GitHub token prefixes (ghs_, ghu_, gho_, ghp_, ghr_, github_pat_), raw or with the underscore URL-encoded as %5F;
// a classic 40-hex token right after a token keyword; and the three-part base64url JWT, whose header always opens with `eyJ`
// and runs well past ten characters, so a dotted file name such as `eyJson.config.js` is not one.
const SHAPES = [
  String.raw`gh[pousr](?:_|%5F)[A-Za-z0-9_]{20,}`,
  String.raw`github(?:_|%5F)pat(?:_|%5F)[A-Za-z0-9_]{20,}`,
  String.raw`(?<=\b(?:token|authorization|bearer)\b[\s"':=]{0,5}(?:(?:token|bearer)\s+)?)[0-9a-f]{40}(?![0-9a-z_])`,
  String.raw`\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+`,
].join("|");
const TOKEN_SHAPE = new RegExp(SHAPES, "gi");
const WHOLE_TOKEN = new RegExp(`^(?:${SHAPES})$`, "i");

/** Replaces every secret and every token-shaped string in `text`, so an error or log line built from `gh` output cannot leak one. */
export function redact(text: string, secrets: readonly string[]): string {
  const exact = secrets.filter((secret) => secret.length > 0).reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  return exact.replace(TOKEN_SHAPE, "[redacted]");
}

/**
 * Redacts two streams as one text, so a token split across them is cut from both halves. One trailing newline on `first`
 * is ignored, since `gh` may end a stream mid-token with one. A head that is already a whole token is redacted on its own,
 * so a token ending `first` does not swallow the first word of `second`.
 */
export function redactStreams(first: string, second: string, secrets: readonly string[]): [string, string] {
  const head = first.replace(/\r?\n$/, "");
  const cuts = [...(head + second).matchAll(TOKEN_SHAPE)].filter(
    (m) => m.index < head.length && m.index + m[0].length > head.length && !WHOLE_TOKEN.test(head.slice(m.index)),
  );
  if (cuts.length === 0) return [redact(first, secrets), redact(second, secrets)];
  const kept = head.slice(0, Math.min(...cuts.map((m) => m.index)));
  const tail = second.slice(Math.max(...cuts.map((m) => m.index + m[0].length)) - head.length);
  return [redact(kept, secrets) + "[redacted]", "[redacted]" + redact(tail, secrets)];
}
