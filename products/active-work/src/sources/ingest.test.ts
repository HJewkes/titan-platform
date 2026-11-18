import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CacheBlobTable } from '@titan-design/store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../errors.js';
import { openGraph } from '../session-index/graph.js';
import { ingestSource } from './ingest.js';

let dir: string;
let db: ReturnType<typeof openGraph>['db'];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-ingest-'));
  db = openGraph(path.join(dir, 'graph.sqlite3')).db;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function writeSource(name: string, body: string): Promise<string> {
  const sourcesDir = path.join(dir, 'initiative', 'sources');
  await fs.mkdir(sourcesDir, { recursive: true });
  const file = path.join(sourcesDir, name);
  await fs.writeFile(file, body, 'utf8');
  return file;
}

const initiativeDir = (): string => path.join(dir, 'initiative');

describe('ingestSource', () => {
  it('keeps the original in place and stores its bytes under the sha256', async () => {
    const file = await writeSource('notes.md', '# Notes\n\nsynthetic body\n');
    const bytes = await fs.readFile(file);

    const result = await ingestSource({ initiativeDir: initiativeDir(), file, db });

    await expect(fs.access(file)).resolves.toBeUndefined();
    expect(result.contentHash).toBe(sha256(bytes));
    const hit = new CacheBlobTable(db).get({
      namespace: 'source',
      model: 'original',
      contentHash: result.contentHash,
    });
    expect(hit?.value.equals(bytes)).toBe(true);
  });

  it('writes the extracted markdown with frontmatter followed by the text', async () => {
    const file = await writeSource('plain.txt', 'line one\nline two\n');

    const result = await ingestSource({ initiativeDir: initiativeDir(), file, db });

    expect(result.extractedPath).toBe(
      path.join(initiativeDir(), 'sources', 'extracted', 'plain.md'),
    );
    const written = await fs.readFile(result.extractedPath, 'utf8');
    expect(written).toContain('source_file: plain.txt');
    expect(written).toContain(`content_hash: ${result.contentHash}`);
    expect(written).toMatch(/extractor: \S+/);
    expect(written).toMatch(/extractor_version: \S+/);
    expect(written.endsWith('line one\nline two\n')).toBe(true);
  });

  it('is a noop on unchanged bytes and leaves the extracted file untouched', async () => {
    const file = await writeSource('stable.md', 'unchanged\n');
    const first = await ingestSource({ initiativeDir: initiativeDir(), file, db });
    const before = await fs.stat(first.extractedPath);
    const contentBefore = await fs.readFile(first.extractedPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await ingestSource({ initiativeDir: initiativeDir(), file, db });

    expect(first.noop).toBe(false);
    expect(second.noop).toBe(true);
    const after = await fs.stat(second.extractedPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(second.extractedPath, 'utf8')).toBe(contentBefore);
  });

  it('rewrites the extracted file when the bytes change', async () => {
    const file = await writeSource('moving.md', 'version one\n');
    const first = await ingestSource({ initiativeDir: initiativeDir(), file, db });
    await fs.writeFile(file, 'version two\n', 'utf8');

    const second = await ingestSource({ initiativeDir: initiativeDir(), file, db });

    expect(second.noop).toBe(false);
    expect(second.contentHash).not.toBe(first.contentHash);
    const written = await fs.readFile(second.extractedPath, 'utf8');
    expect(written).toContain(`content_hash: ${second.contentHash}`);
    expect(written.endsWith('version two\n')).toBe(true);
  });

  it('refuses a pdf', async () => {
    const file = await writeSource('paper.pdf', '%PDF-1.4 synthetic');

    await expect(ingestSource({ initiativeDir: initiativeDir(), file, db })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
