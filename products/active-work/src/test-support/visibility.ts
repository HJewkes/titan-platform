import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { charterPath } from '../sessions/charter.js';
import { visibilityFor, type Shown } from '../sessions/visibility.js';

export const CHARTER_INITIATIVE = 'claude-channels';

const CHARTER_BRIEF =
  '---\nschema_version: 5\ntitle: Channels\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: CC\nvisibility: owner-only\n---\n\nBody.\n';

/**
 * Agents are shown nothing while the charter is unreadable (TP-5556), so a fixture that wants an
 * agent to see an agent-visible initiative writes a charter first. The charter lives inside its
 * own owner-only initiative, which is listed to the owner and counted as hidden for an agent.
 */
export function writeCharter(activeRoot: string, humanOnly: readonly string[] = []): void {
  const file = charterPath(activeRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(path.join(activeRoot, CHARTER_INITIATIVE, 'brief.md'), CHARTER_BRIEF, 'utf8');
  writeFileSync(file, `---\nhuman_only_initiatives: ${JSON.stringify(humanOnly)}\n---\nCharter body\n`, 'utf8');
}

/** What the owner is served: every row. */
export function ownerShown(activeRoot: string): Promise<Shown> {
  return visibilityFor({ activeRoot, caller: 'owner', warnings: [] });
}
