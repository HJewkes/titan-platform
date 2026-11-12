import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every command is an MCP tool, so a command that lists the active root itself serves owner-only
 * initiatives to an agent (TP-5453 P6b). Commands enumerate through `listSlugsForCaller`; the
 * files below read the root for a reason that returns no initiative to the caller unfiltered.
 */
const ROOT_READERS: Record<string, string> = {
  'audit.ts': 'scanInitiativesForCaller filters the scan by the caller',
  'context-graph.ts': 'filters every slug through loadAgentVisibility for every caller',
  'new.ts': 'reads ranks to pick the next one and returns no other initiative',
  'sessions-browser.ts': 'uses initiative roots only to exclude sessions under them',
  '_focus-helpers.ts': 'focus, pause, unfocus and unpause renumber the whole focused list',
};

const COMMANDS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIRECT_ENUMERATOR = /\blistInitiativeSlugs(OrEmpty)?\b/;
const ROOT_READDIR = /readdir\((root|activeRoot|getActiveRoot\(\)|ctx\.activeRoot)[,)]/;

function commandSources(): { file: string; source: string }[] {
  return readdirSync(COMMANDS_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(path.join(COMMANDS_DIR, file), 'utf8') }));
}

describe('initiative enumeration in commands', () => {
  it('goes through listSlugsForCaller, never the raw slug listers', () => {
    const offenders = commandSources().filter(({ source }) => DIRECT_ENUMERATOR.test(source));

    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('reads the active root directly only in the files that say why', () => {
    const readers = commandSources().filter(({ source }) => ROOT_READDIR.test(source));

    expect(readers.map(({ file }) => file).sort()).toEqual(Object.keys(ROOT_READERS).sort());
  });
});
