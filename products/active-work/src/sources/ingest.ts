import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CacheBlobTable, type Db } from '@titan-design/store-sqlite';

import { ValidationError } from '../errors.js';
import { atomicWrite } from '../utils/fs-atomic.js';

const TEXT_EXTENSIONS = new Set(['.md', '.txt']);
const EXTRACTOR = 'plain-text';
const EXTRACTOR_VERSION = '1';

interface IngestResult {
  contentHash: string;
  extractedPath: string;
  noop: boolean;
}

function frontmatterFor(sourceFile: string, contentHash: string): string {
  return [
    '---',
    `source_file: ${sourceFile}`,
    `content_hash: ${contentHash}`,
    `extractor: ${EXTRACTOR}`,
    `extractor_version: ${EXTRACTOR_VERSION}`,
    '---',
    '',
  ].join('\n');
}

/** An extracted file is current when its frontmatter already names this hash and extractor version. */
async function isCurrent(extractedPath: string, header: string): Promise<boolean> {
  try {
    return (await fs.readFile(extractedPath, 'utf8')).startsWith(header);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Content-address a source's bytes into `cache_blob` and extract its text to
 * `sources/extracted/<stem>.md`. The original is never moved or modified.
 */
export async function ingestSource(input: {
  initiativeDir: string;
  file: string;
  db: Db;
}): Promise<IngestResult> {
  const extension = path.extname(input.file).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw new ValidationError(
      `Cannot ingest ${path.basename(input.file)}: only .md and .txt sources are supported`,
    );
  }
  const bytes = await fs.readFile(input.file);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  new CacheBlobTable(input.db).put({ namespace: 'source', model: 'original', contentHash }, bytes);

  const sourceFile = path.basename(input.file);
  const extractedDir = path.join(input.initiativeDir, 'sources', 'extracted');
  const extractedPath = path.join(extractedDir, `${path.basename(sourceFile, extension)}.md`);
  const header = frontmatterFor(sourceFile, contentHash);
  if (await isCurrent(extractedPath, header)) return { contentHash, extractedPath, noop: true };

  await fs.mkdir(extractedDir, { recursive: true });
  await atomicWrite(extractedPath, header + bytes.toString('utf8'));
  return { contentHash, extractedPath, noop: false };
}
