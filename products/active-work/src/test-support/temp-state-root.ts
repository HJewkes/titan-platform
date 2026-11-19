import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import * as paths from '../utils/paths.js';
import { assertSafeToRemove } from './test-helpers.js';

/**
 * Points `getStateRoot()` at a fresh temp dir for each test in the calling file.
 * The vitest run shares one isolated home across every worker thread, so without
 * this, files that stash spawn context under the same agentId race on one file (TP-5611).
 */
export function useTempStateRoot(): void {
  let stateRoot = '';
  beforeEach(() => {
    stateRoot = mkdtempSync(join(os.tmpdir(), 'aw-test-state-'));
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(stateRoot);
  });
  afterEach(() => {
    vi.mocked(paths.getStateRoot).mockRestore();
    assertSafeToRemove(stateRoot);
    rmSync(stateRoot, { recursive: true, force: true });
  });
}
