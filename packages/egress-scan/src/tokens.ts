export type TokenKind = "github" | "anthropic" | "aws-access-key" | "slack" | "private-key";

export interface TokenHit {
  readonly kind: TokenKind;
  readonly offset: number;
}

// A token must stand alone: a run glued to a longer word or a base64 blob is not one.
const START = String.raw`(?<![A-Za-z0-9+/_-])`;
const END = String.raw`(?![A-Za-z0-9+/_-])`;

// Each shape pins its prefix, charset and length, so a bare prefix in prose never fires.
const SHAPES: readonly { readonly kind: TokenKind; readonly pattern: RegExp }[] = [
  { kind: "github", pattern: new RegExp(`${START}(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59,221})${END}`) },
  { kind: "anthropic", pattern: new RegExp(`${START}sk-ant-[a-z]+[0-9]{2}-[A-Za-z0-9_-]{80,}`) },
  { kind: "aws-access-key", pattern: new RegExp(`${START}(?:AKIA|ASIA)[A-Z0-9]{16}${END}`) },
  { kind: "slack", pattern: new RegExp(`${START}xox[abprs]-(?:[0-9]{1,13}-){1,3}[A-Za-z0-9]{16,64}${END}`) },
  { kind: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
];

/** Each token kind in `text` once, at its first offset. A hit never carries the matched text. */
export function locateTokens(text: string): TokenHit[] {
  const hits: TokenHit[] = [];
  for (const { kind, pattern } of SHAPES) {
    const match = pattern.exec(text);
    if (match) hits.push({ kind, offset: match.index });
  }
  return hits;
}
