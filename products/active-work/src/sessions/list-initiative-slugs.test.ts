import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listInitiativeSlugs, listInitiativeSlugsOrEmpty } from './initiatives.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'aw-slugs-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listInitiativeSlugs', () => {
  it('lists non-dot directories sorted', async () => {
    mkdirSync(path.join(root, 'beta'));
    mkdirSync(path.join(root, 'alpha'));
    mkdirSync(path.join(root, '.sessions'));
    writeFileSync(path.join(root, 'file.txt'), '');

    expect(await listInitiativeSlugs(root)).toEqual(['alpha', 'beta']);
  });

  it('returns an empty list when the root does not exist', async () => {
    expect(await listInitiativeSlugs(path.join(root, 'missing'))).toEqual([]);
  });

  it('rethrows a non-ENOENT read error', async () => {
    const notADirectory = path.join(root, 'file.txt');
    writeFileSync(notADirectory, '');

    await expect(listInitiativeSlugs(notADirectory)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('the lenient variant degrades a non-ENOENT read error to an empty list', async () => {
    const notADirectory = path.join(root, 'file.txt');
    writeFileSync(notADirectory, '');

    expect(await listInitiativeSlugsOrEmpty(notADirectory)).toEqual([]);
  });
});
