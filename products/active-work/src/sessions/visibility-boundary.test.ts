import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Which initiatives an agent may read is decided once, in `sessions/visibility.ts` (TP-5556).
 * #3690 failed four review rounds because each reader made that call itself, so these checks
 * keep every other file from rebuilding the verdict, enumerating initiatives unfiltered, or
 * reading the caller to filter. Each exemption names why it serves no initiative it should not.
 */

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOADER = 'sessions/visibility.ts';

const VERDICT_BUILDERS = /\b(isAgentVisible|agentAccess|loadAgentVisibility|callerVisibility)\b/;
const RAW_ENUMERATOR = /\blistInitiativeSlugs(OrEmpty)?\b/;
const BRIEF_ONLY = /\b(briefAllowsAgents|initiativeIsAgentVisible)\b/;
const CHARTER_READ = /\bloadHumanOnlyInitiatives\b/;
const WIRE_FIELD = /\b(withheld_from_agents|agent_visible)\b/;
const CALLER_READ = /\.caller\b/;
const CALLER_WRITE = /\bcaller:\s*(?!CommandContext\b)\S/;
const ROOT_READDIR = /readdir\((root|activeRoot|getActiveRoot\(\)|ctx\.activeRoot)[,)]/;

const RAW_ENUMERATORS: Record<string, string> = {
  'sessions/initiatives.ts': 'defines the listers',
  'tasks/edge-index.ts': 'builds the dependency index that task commands resolve named ids against',
  'lint/index.ts': 'lints every brief; audit and doctor filter what they print',
  'workspace-index/inventory.ts': 'counts files for the inventory cache; inventory rows come from listSlugsForCaller',
  'workspace-index/scan.ts': 'walks the root to build the search index; search filters hits through Shown',
  'decider/ledger.ts': 'finds v1 precedent files to import; precedent search filters rows through Shown',
  'decider/queue-source.ts': 'resolves which initiative an answer belongs to, for the extract exclusion policy',
  'migrations/v2-to-v3-plan.ts': 'migration plan; migrate refuses every caller but the owner',
  'session-index/loop-board.ts': 'loads every loop; the loop board command filters them through Shown',
  'sessions/resolve-session-location.ts': 'finds the one initiative holding a session id the caller named',
};

const BRIEF_ONLY_WRITERS: Record<string, string> = {
  'workspace-index/scan.ts': 'keeps owner-only files out of the search index; search re-filters through Shown',
  'workspace-index/read.ts': 'keeps owner-only brief spans out of the search index; search re-filters through Shown',
  'commands/task-backfill-fields.ts': 'skips writes to owner-only initiatives; returns no initiative to the caller',
};

const CHARTER_READERS: Record<string, string> = {
  'sessions/charter.ts': 'defines the charter read',
  'commands/_list-scope.ts': 'sets the human_only export flag on rows already filtered through Shown',
  'decider/extract.ts': 'excludes human-only answers from the precedent ledger it writes',
};

const WIRE_EMITTERS: Record<string, string> = {
  'commands/inventory.ts': 'emits withheld_from_agents and agent_visible for the factory and console',
  'commands/task-keys.ts': 'emits agent_visible for the factory task-key resolver',
};

const CALLER_READERS: Record<string, string> = {
  'commands/_draft-promotion.ts': 'only the owner may promote a draft task: a write gate',
  'commands/_task-provenance.ts': "records who filed a task: provenance",
  'commands/_task-related.ts': 'attaches related refs to tasks an agent files: provenance',
  'commands/_task-apply-run.ts': 'applies the draft-promotion write gate to a batch',
  'commands/precedent-search.ts': 'only the owner may widen to precedents no initiative claims; rows go through Shown',
  'commands/set.ts': 'owner-only fields refuse agent writes: a write gate',
  'commands/task-add.ts': 'agent-filed tasks must be drafts: a write gate',
  'commands/task-apply.ts': 'passes the caller to the draft-promotion write gate',
  'commands/task-list.ts': 'only the owner prunes missing initiatives from the listing cache: a write gate',
};

const SURFACES: Record<string, string> = {
  'program.ts': 'CLI: the owner unless agent env vars are set',
  'launcher-open.ts': 'aw open: as the CLI',
  'launcher-resume.ts': 'aw resume: as the CLI',
  'server/http.ts': 'loopback /rpc: the owner',
  'server/mcp.ts': 'MCP: an agent',
};

const ROOT_READERS: Record<string, string> = {
  'commands/audit.ts': 'scanInitiativesForCaller filters the scan through Shown',
  'commands/new.ts': 'reads ranks to pick the next one and returns no other initiative',
  'commands/sessions-browser.ts': 'uses initiative roots only to exclude sessions under them',
  'commands/_focus-helpers.ts': 'focus, pause, unfocus and unpause renumber the whole focused list',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-support' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// Prose may name what it must not call, so comments are dropped before matching.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SOURCES = sourceFiles(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  source: withoutComments(readFileSync(file, 'utf8')),
}));

function filesMatching(pattern: RegExp): string[] {
  return SOURCES.filter(({ file, source }) => file !== LOADER && pattern.test(source))
    .map(({ file }) => file)
    .sort();
}

describe('the visibility boundary in active-work', () => {
  it('builds the verdict only in the loader', () => {
    expect(filesMatching(VERDICT_BUILDERS)).toEqual([]);
  });

  it('enumerates the root raw only where the reason is named', () => {
    expect(filesMatching(RAW_ENUMERATOR)).toEqual(Object.keys(RAW_ENUMERATORS).sort());
  });

  it('applies the brief-only rule only in the index and back-fill writers', () => {
    expect(filesMatching(BRIEF_ONLY)).toEqual(Object.keys(BRIEF_ONLY_WRITERS).sort());
  });

  it('reads the charter human-only list only where the reason is named', () => {
    expect(filesMatching(CHARTER_READ)).toEqual(Object.keys(CHARTER_READERS).sort());
  });

  it('names the wire visibility fields only in their emitters', () => {
    expect(filesMatching(WIRE_FIELD)).toEqual(Object.keys(WIRE_EMITTERS).sort());
  });

  it('reads the caller only for provenance and write gates', () => {
    expect(filesMatching(CALLER_READ)).toEqual(Object.keys(CALLER_READERS).sort());
  });

  it('sets the caller only on the surfaces', () => {
    expect(filesMatching(CALLER_WRITE)).toEqual(Object.keys(SURFACES).sort());
  });

  it('reads the active root directly only in the commands that say why', () => {
    const readers = filesMatching(ROOT_READDIR).filter((file) => file.startsWith('commands/'));

    expect(readers).toEqual(Object.keys(ROOT_READERS).sort());
  });
});
