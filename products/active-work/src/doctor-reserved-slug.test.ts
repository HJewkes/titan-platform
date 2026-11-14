import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkReservedSlugs } from './doctor/checks-data.js';
import { writeCharter } from './test-support/visibility.js';
import { visibilityFor, type Shown } from './sessions/visibility.js';

describe('checkReservedSlugs', () => {
  let base: string;
  let activeRoot: string;

  beforeEach(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'aw-doctor-reserved-'));
    activeRoot = path.join(base, 'active');
    await fs.mkdir(activeRoot, { recursive: true });
    await fs.writeFile(path.join(activeRoot, '.schema-version'), '1\n', 'utf8');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  async function seed(...slugs: string[]): Promise<void> {
    for (const slug of slugs) {
      await fs.mkdir(path.join(activeRoot, slug), { recursive: true });
      await fs.writeFile(path.join(activeRoot, slug, 'brief.md'), '# brief\n', 'utf8');
    }
  }

  const run = (shown: Shown) => checkReservedSlugs({ activeRoot, shown });

  it('names an initiative called other, with the rename remedy, for the owner', async () => {
    await seed('other', 'alpha');
    const shown = await visibilityFor({ activeRoot, caller: 'owner', warnings: [] });

    const check = await run(shown);

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('rename the initiative directory');
    expect(check.detail).toContain('other');
    expect(check.detail).not.toContain('alpha');
  });

  it('reports ok when no slug is reserved', async () => {
    await seed('alpha');
    const shown = await visibilityFor({ activeRoot, caller: 'owner', warnings: [] });

    expect((await run(shown)).status).toBe('ok');
  });

  it('leaves out a reserved-slug initiative withheld from the caller', async () => {
    writeCharter(activeRoot, []);
    await seed('other');
    await fs.writeFile(
      path.join(activeRoot, 'other', 'brief.md'),
      '---\ntitle: other\nschema_version: 5\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: XX\n---\n\nBody.\n',
      'utf8',
    );
    const shown = await visibilityFor({ activeRoot, caller: 'agent', warnings: [] });

    const check = await run(shown);

    expect(check.status).toBe('ok');
    expect(check.detail).not.toContain('other');
  });
});
