import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/**
 * The generator resolves its output next to itself (`../docs`), so run a copy of the script inside a scratch
 * product root whose dist/ and src/ link back to the real ones. The tracked docs/cli-reference.md is never touched.
 */
function scratchProductRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aw-cli-reference-'));
  scratch = root;
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'docs'));
  cpSync(
    path.join(productRoot, 'scripts/gen-cli-reference.mjs'),
    path.join(root, 'scripts/gen-cli-reference.mjs'),
  );
  symlinkSync(path.join(productRoot, 'dist'), path.join(root, 'dist'));
  symlinkSync(path.join(productRoot, 'src'), path.join(root, 'src'));
  return root;
}

describe('gen-cli-reference', () => {
  it('writes a non-empty docs/cli-reference.md', () => {
    expect(existsSync(path.join(productRoot, 'dist/program.js')), 'run pnpm build first').toBe(true);
    const root = scratchProductRoot();

    const run = spawnSync(process.execPath, [path.join(root, 'scripts/gen-cli-reference.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: os.homedir() },
    });

    expect(run.stderr).toContain('wrote ');
    expect(run.status).toBe(0);
    const reference = readFileSync(path.join(root, 'docs/cli-reference.md'), 'utf8');
    expect(reference).toMatch(/^# CLI reference/);
    expect(reference).toContain('## active-work');
    expect(reference).toContain('Usage: active-work');
  }, 300_000);
});
