import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as paths from './utils/paths.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  }),
}));

const { spawnClaude } = await import('./launcher-open.js');

describe('spawnClaude usage record', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-launch-usage-'));
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(stateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('appends one aw.launch line whose duration_ms counts from process start to just before spawn', async () => {
    const before = performance.now();
    await spawnClaude(
      { slug: 'sample-initiative', prompt: 'p', cwd_hint: '.' },
      os.tmpdir(),
      { remoteControl: false },
    );

    const lines = (await fs.readFile(path.join(stateDir, 'usage.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l): { command: string; duration_ms: number; args: { slug: string } } => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ command: 'aw.launch', args: { slug: 'sample-initiative' } });
    expect(lines.at(0)?.duration_ms).toBeGreaterThanOrEqual(before);
  });
});
