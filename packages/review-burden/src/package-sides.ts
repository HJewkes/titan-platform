import { isRecord } from '@titan-design/rpc-protocol/narrow';
import type { ChangedFile, PackageJsonChange } from './config.js';

/** The git reads the sides need; the bin passes its CliDeps. */
interface ManifestReader {
  mergeBase(base: string): string;
  show(rev: string, path: string): string;
  err(text: string): void;
}

const MANIFEST = /(^|\/)package\.json$/;

function parseManifest(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('not a JSON object');
  return parsed;
}

function readSides(file: ChangedFile, mergeBaseSha: string, git: ManifestReader): PackageJsonChange {
  const change: PackageJsonChange = { path: file.path };
  if (file.status !== 'added' && file.status !== 'copied') {
    change.base = parseManifest(git.show(mergeBaseSha, file.previousPath ?? file.path));
  }
  if (file.status !== 'removed') change.head = parseManifest(git.show('HEAD', file.path));
  return change;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Each changed `package.json` parsed on the merge-base side and the HEAD side. An added or copied manifest has
 * no base side; a removed one has no head side. A side that cannot be read or parsed skips that manifest with
 * a warning on `err`, so a bad read never invents a removed key.
 */
export function packageJsonChanges(files: readonly ChangedFile[], base: string, git: ManifestReader): PackageJsonChange[] {
  const manifests = files.filter((file) => MANIFEST.test(file.path));
  if (manifests.length === 0) return [];
  let mergeBaseSha: string;
  try {
    mergeBaseSha = git.mergeBase(base);
  } catch (error) {
    git.err(`review-burden: skipped package.json sides: ${message(error)}\n`);
    return [];
  }
  const changes: PackageJsonChange[] = [];
  for (const file of manifests) {
    try {
      changes.push(readSides(file, mergeBaseSha, git));
    } catch (error) {
      git.err(`review-burden: skipped ${file.path}: ${message(error)}\n`);
    }
  }
  return changes;
}
