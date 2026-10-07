import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repoForCwd, toRepoRelative } from './refs.js';
import { clearRepoCache, parseOriginUrl, repoNameFromRemoteUrl, resolveRepo } from './repo-root.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'session-read-repo-root-'));
  clearRepoCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearRepoCache();
});

/** A working tree is a `.git` directory; `origin` is what names it. */
function makeRepo(at: string, originUrl?: string): string {
  mkdirSync(path.join(at, '.git'), { recursive: true });
  if (originUrl) {
    writeFileSync(path.join(at, '.git', 'config'), `[remote "origin"]\n\turl = ${originUrl}\n`);
  }
  return at;
}

describe('resolveRepo', () => {
  it('names a repo from its origin remote, not its directory name', () => {
    const root = makeRepo(
      path.join(dir, 'checked-out-as-something-else'),
      'git@github.com:acme/demo.git',
    );

    expect(resolveRepo(root)).toEqual({ root, name: 'demo' });
  });

  it('falls back to the toplevel basename when there is no origin remote', () => {
    const root = makeRepo(path.join(dir, 'local-only'));

    expect(resolveRepo(root)).toEqual({ root, name: 'local-only' });
  });

  it('resolves a nested directory to its enclosing working tree', () => {
    const root = makeRepo(path.join(dir, 'demo'), 'https://github.com/acme/demo');
    const nested = path.join(root, 'src', 'miner', 'deep');
    mkdirSync(nested, { recursive: true });

    expect(resolveRepo(nested)).toEqual({ root, name: 'demo' });
  });

  it('resolves a linked worktree through its gitdir pointer and commondir', () => {
    const main = makeRepo(path.join(dir, 'demo'), 'git@github.com:acme/demo.git');
    const worktreeGitDir = path.join(main, '.git', 'worktrees', 'wt');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    const worktree = path.join(dir, 'wt-checkout');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);

    expect(resolveRepo(worktree)).toEqual({ root: worktree, name: 'demo' });
  });

  it('returns null for a directory with no .git ancestor', () => {
    const plain = path.join(dir, 'state', 'tracker');
    mkdirSync(plain, { recursive: true });

    expect(resolveRepo(plain)).toBeNull();
  });
});

describe('toRepoRelative', () => {
  it('attributes a file to its enclosing repo, relative to the working-tree root', () => {
    const root = makeRepo(path.join(dir, 'demo'), 'git@github.com:acme/demo.git');
    mkdirSync(path.join(root, 'src'), { recursive: true });

    expect(toRepoRelative(path.join(root, 'src', 'app.ts'))).toEqual({
      repo: 'demo',
      path: 'src/app.ts',
    });
  });

  it('is independent of which subdirectory the tool call ran in', () => {
    const root = makeRepo(path.join(dir, 'demo'));
    mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });

    expect(toRepoRelative(path.join(root, 'src', 'nested', 'app.ts')).path).toBe(
      'src/nested/app.ts',
    );
  });

  it('leaves a state directory sharing a repo basename unattributed', () => {
    const repo = makeRepo(path.join(dir, 'projects', 'tracker'), 'git@github.com:acme/tracker.git');
    const stateDir = path.join(dir, 'Application Support', 'tracker', 'tracker');
    mkdirSync(stateDir, { recursive: true });

    const tracked = toRepoRelative(path.join(repo, 'brief.md'));
    const state = toRepoRelative(path.join(stateDir, 'brief.md'));

    expect(tracked).toEqual({ repo: 'tracker', path: 'brief.md' });
    expect(state).toEqual({ repo: null, path: path.join(stateDir, 'brief.md') });
  });

  it('leaves a non-absolute path alone because it has no anchor to resolve against', () => {
    expect(toRepoRelative('src/app.ts')).toEqual({ repo: null, path: 'src/app.ts' });
  });
});

describe('repoForCwd', () => {
  it('names the repo a tool call ran in, and nothing for a plain directory or null', () => {
    const root = makeRepo(path.join(dir, 'demo'), 'git@github.com:acme/demo.git');
    const plain = path.join(dir, 'plain');
    mkdirSync(plain, { recursive: true });

    expect(repoForCwd(root)).toBe('demo');
    expect(repoForCwd(plain)).toBeNull();
    expect(repoForCwd(null)).toBeNull();
  });
});

describe('parseOriginUrl', () => {
  it('reads url from the origin section only', () => {
    const config = [
      '[core]',
      '\turl = not-a-remote',
      '[remote "upstream"]',
      '\turl = git@github.com:other/upstream.git',
      '[remote "origin"]',
      '\turl = git@github.com:acme/demo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n');

    expect(parseOriginUrl(config)).toBe('git@github.com:acme/demo.git');
  });

  it('returns null when there is no origin', () => {
    expect(parseOriginUrl('[remote "upstream"]\n\turl = x\n')).toBeNull();
  });
});

describe('repoNameFromRemoteUrl', () => {
  it.each([
    ['git@github.com:acme/demo.git', 'demo'],
    ['https://github.com/acme/demo', 'demo'],
    ['https://github.com/acme/demo.git/', 'demo'],
    ['/srv/mirrors/demo.git', 'demo'],
  ])('derives a short repo name from %s', (url, expected) => {
    expect(repoNameFromRemoteUrl(url)).toBe(expected);
  });
});
