import type { ChangedFile, FileStatus } from './config.js';

/**
 * Parses `git diff --numstat -z`: `add<TAB>del<TAB>path<NUL>`, and for a rename `add<TAB>del<TAB><NUL>old<NUL>new<NUL>`.
 */
function parseNumstat(text: string): ChangedFile[] {
  const fields = text.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const [add = '0', del = '0', ...rest] = (fields[i] ?? '').split('\t');
    if (rest.length === 0) continue;
    const named = rest.join('\t');
    const paths = named === '' ? { previousPath: fields[++i] ?? '', path: fields[++i] ?? '' } : { path: named, previousPath: undefined };
    const file: ChangedFile = {
      path: paths.path,
      status: paths.previousPath ? 'renamed' : 'modified',
      additions: Number(add) || 0,
      deletions: Number(del) || 0,
    };
    if (paths.previousPath) file.previousPath = paths.previousPath;
    files.push(file);
  }
  return files;
}

interface NamedStatus {
  status: FileStatus;
  previousPath?: string;
}

const STATUS_LETTERS: Readonly<Record<string, FileStatus>> = { A: 'added', D: 'removed', R: 'renamed', C: 'copied' };

/**
 * Parses `git diff --name-status -z`: `X<NUL>path<NUL>`, and for a rename or copy `R100<NUL>old<NUL>new<NUL>`.
 * Keyed by the head-side path. Letters other than A, D, R and C (M, T, U, X) read as `modified`.
 */
export function parseNameStatus(text: string): Map<string, NamedStatus> {
  const fields = text.split('\0');
  const named = new Map<string, NamedStatus>();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    if (field === '') continue;
    const letter = field[0] ?? '';
    const moved = letter === 'R' || letter === 'C';
    const previousPath = moved ? fields[++i] : undefined;
    const path = fields[++i];
    if (!path) continue;
    const entry: NamedStatus = { status: STATUS_LETTERS[letter] ?? 'modified' };
    if (previousPath) entry.previousPath = previousPath;
    named.set(path, entry);
  }
  return named;
}

/** numstat's files with name-status's status and previous path laid over; a path name-status lacks keeps numstat's guess. */
export function changedFiles(numstat: string, nameStatus: string): ChangedFile[] {
  const named = parseNameStatus(nameStatus);
  return parseNumstat(numstat).map((file) => {
    const found = named.get(file.path);
    if (!found) return file;
    const merged: ChangedFile = { ...file, status: found.status };
    if (found.previousPath) merged.previousPath = found.previousPath;
    return merged;
  });
}
