import type { RedirectToken, WordToken } from "./tokens.js";

/** One way to read a command's words and redirects. */
interface Reading {
  words: WordToken[];
  redirects: RedirectToken[];
}

/**
 * bash and zsh read a `{name}` word before a redirect as the descriptor it stores, which the shell numbers from 10 up;
 * dash, and bash a space apart, keep it as a word. Null when no word is one; else the word's reading, then the fd's.
 */
export function namedFdReadings(words: WordToken[], redirects: RedirectToken[]): [Reading, Reading] | null {
  if (!words.some((word) => word.namedFd)) return null;
  const kept = { words: words.map(withoutNamedFd), redirects: redirects.map(withoutNamed) };
  const asFd = redirects.map((r) => (r.named === undefined ? r : { ...r, fd: r.named }));
  return [kept, { words: words.filter((word) => !word.namedFd), redirects: asFd }];
}

function withoutNamedFd({ namedFd: _namedFd, ...word }: WordToken): WordToken {
  return word;
}

function withoutNamed({ named: _named, ...redirect }: RedirectToken): RedirectToken {
  return redirect;
}
