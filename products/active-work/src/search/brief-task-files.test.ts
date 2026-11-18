import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeCharter } from '../test-support/visibility.js';
import { scaffold, writeFile } from '../test-support/workspace-index/fixture.js';
import { namedFiles, taskFiles } from './brief-task-files.js';

/** `alpha` is agent-visible; `hidden-work` is owner-only, so its task's files never reach a brief. */

let dir: string;
let root: string;

function writeTask(slug: string, id: string, fields: string): void {
  writeFile(
    root,
    `${slug}/tasks/${id}.yml`,
    `id: ${id}\ntitle: A task\npriority: 1\nstatus: open\ncreated: 2026-10-01\nupdated: 2026-10-01\ndone_at: null\n${fields}`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-brief-task-files-'));
  root = path.join(dir, 'active-work');
  scaffold(root);
  writeCharter(root);
  writeFile(
    root,
    'hidden-work/brief.md',
    '---\nschema_version: 5\ntitle: hidden\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: HW\n---\n\nBody.\n',
  );
  writeTask(
    'alpha',
    'AL-9',
    'done_when: packages/demo/src/app.ts renders\nnotes: |\n  Some history.\n\n  owns: packages/demo/src/view.ts,\n  packages/demo/src/view.test.ts\n\n  Later: packages/demo/src/unrelated.ts\n',
  );
  writeTask('hidden-work', 'HW-3', 'done_when: packages/secret/src/vault.ts works\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('namedFiles', () => {
  it('keeps repo-relative paths and skips absolute ones and URLs', () => {
    const text = 'Edit src/a.ts and src/a.ts, not /abs/b.ts or https://x.io/c.ts, nor ~/d/e.ts.';

    expect(namedFiles(text)).toEqual(['src/a.ts']);
  });
});

describe('taskFiles', () => {
  it('adds the done_when and owns paths of a task the assignment names', async () => {
    const files = await taskFiles({ text: 'Work AL-9; see docs/guide.md.', activeRoot: root });

    expect(files).toEqual([
      'docs/guide.md',
      'packages/demo/src/app.ts',
      'packages/demo/src/view.ts',
      'packages/demo/src/view.test.ts',
    ]);
  });

  it('never reads a task in an initiative the agent view withholds', async () => {
    const files = await taskFiles({ text: 'Work HW-3.', activeRoot: root });

    expect(files).toEqual([]);
  });

  it('an unknown key adds nothing', async () => {
    const files = await taskFiles({ text: 'Work AL-404 in src/a.ts.', activeRoot: root, initiative: 'alpha' });

    expect(files).toEqual(['src/a.ts']);
  });
});
