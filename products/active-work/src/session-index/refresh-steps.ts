import { refreshCorpus } from '@titan-design/session-graph';
import { writeEpisodes } from '@titan-design/session-analytics';
import { refreshWorkspace } from '../workspace-index/refresh.js';
import { replayPreserved } from './preserve.js';
import { refreshEpisodes } from './episodes.js';

/**
 * The phases a refresh pass hands work to. `runRefresh` orders them; a test
 * swaps one to watch the order or cut a pass short, without mocking a module.
 */
export interface RefreshSteps {
  refreshCorpus: typeof refreshCorpus;
  refreshEpisodes: typeof refreshEpisodes;
  /** Passed into `refreshEpisodes`, one call per session. */
  writeEpisodes: typeof writeEpisodes;
  refreshWorkspace: typeof refreshWorkspace;
  replayPreserved: typeof replayPreserved;
}

const DEFAULT_STEPS: RefreshSteps = {
  refreshCorpus,
  refreshEpisodes,
  writeEpisodes,
  refreshWorkspace,
  replayPreserved,
};

export function refreshSteps(over: Partial<RefreshSteps> = {}): RefreshSteps {
  return { ...DEFAULT_STEPS, ...over };
}
