const CLASSIC = /^ghp_[A-Za-z0-9]{36}$/;
const FINE_GRAINED = /^github_pat_[A-Za-z0-9_]{22,255}$/;

/**
 * Parse the text of a GitHub personal access token file: a classic `ghp_` token or a
 * fine-grained `github_pat_` token, with one optional trailing newline. Returns the token.
 * The error text never quotes the input, so a caught error is safe to log.
 */
export function parseGitHubToken(raw: string): string {
  const token = raw.replace(/\r?\n$/, "");
  if (CLASSIC.test(token) || FINE_GRAINED.test(token)) return token;
  throw new Error("not a GitHub personal access token (expected a ghp_ or github_pat_ shape)");
}
