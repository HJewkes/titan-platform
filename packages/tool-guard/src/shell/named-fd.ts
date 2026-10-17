import type { RedirectToken, WordToken } from "./tokens.js";

/** One way to read a command's words and redirects. */
interface Reading {
  words: WordToken[];
  redirects: RedirectToken[];
}

type Kind = NonNullable<WordToken["namedFd"]>;

/**
 * Each shell's reading of a command's `{name}` words before redirects, which the shell numbers from 10 up when it reads
 * one as the descriptor it stores. Null when no word is one; else zsh's, which reads every one as the fd, then dash's,
 * which keeps every one a word, then bash's, which reads only a glued one as the fd, when it differs from both.
 */
export function namedFdReadings(words: WordToken[], redirects: RedirectToken[]): [Reading, ...Reading[]] | null {
  const kinds = words.flatMap((word) => (word.namedFd ? [word.namedFd] : []));
  if (kinds.length === 0) return null;
  const readings: [Reading, ...Reading[]] = [readingAs(words, redirects, kinds, () => true), readingAs(words, redirects, kinds, () => false)];
  if (new Set(kinds).size > 1) readings.push(readingAs(words, redirects, kinds, (kind) => kind === "glued"));
  return readings;
}

/** `shell`'s one reading of a command's `{name}` words: zsh reads every one as the fd, bash only a glued one. */
export function shellReading(words: WordToken[], redirects: RedirectToken[], shell: "bash" | "zsh"): Reading {
  const kinds = words.flatMap((word) => (word.namedFd ? [word.namedFd] : []));
  if (kinds.length === 0) return { words, redirects };
  return readingAs(words, redirects, kinds, (kind) => shell === "zsh" || kind === "glued");
}

/** The marked words and the named redirects pair up in order, as each word stands just before its redirect. */
function readingAs(words: WordToken[], redirects: RedirectToken[], kinds: Kind[], asFd: (kind: Kind) => boolean): Reading {
  let next = 0;
  const read = redirects.map((r) => {
    if (r.named === undefined) return r;
    return asFd(kinds[next++] ?? "glued") ? { ...r, fd: r.named } : withoutNamed(r);
  });
  return { words: words.flatMap((word) => (!word.namedFd ? [word] : asFd(word.namedFd) ? [] : [withoutNamedFd(word)])), redirects: read };
}

function withoutNamedFd({ namedFd: _namedFd, ...word }: WordToken): WordToken {
  return word;
}

function withoutNamed({ named: _named, ...redirect }: RedirectToken): RedirectToken {
  return redirect;
}
