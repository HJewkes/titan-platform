/** Local setup steps: Node version, active/state/config dirs, schema version and config stub. */
import nodePath from 'node:path';
import { errorCode } from '@titan-design/rpc-protocol/narrow';
import { errorText } from './errors.js';
import { ensureSchemaVersion } from '../migrations/ensure-schema.js';
import {
  ensureDir,
  resolveDeps,
  STEP_CHECK_NODE,
  STEP_CONFIG,
  STEP_CREATE_ACTIVE,
  STEP_SCHEMA,
  type SetupDeps,
  type StepResult,
} from './steps-deps.js';

const MIN_NODE_MAJOR = 22;

function parseNodeMajor(version: string): number {
  const cleaned = version.startsWith('v') ? version.slice(1) : version;
  const major = Number(cleaned.split('.')[0]);
  return Number.isFinite(major) ? major : 0;
}

export async function stepCheckNode(deps: SetupDeps = {}): Promise<StepResult> {
  void deps;
  const major = parseNodeMajor(process.versions.node);
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      name: STEP_CHECK_NODE,
      error: `Node ${MIN_NODE_MAJOR}+ required, found v${process.versions.node}`,
    };
  }
  return {
    ok: true,
    name: STEP_CHECK_NODE,
    done: true,
    message: `Node v${process.versions.node} OK`,
  };
}

export async function stepCreateActiveRoot(deps: SetupDeps = {}): Promise<StepResult> {
  const { fs, paths } = resolveDeps(deps);
  try {
    const created: string[] = [];
    for (const dir of [paths.activeRoot, paths.stateRoot, paths.configRoot]) {
      const { created: didCreate } = await ensureDir(fs, dir);
      if (didCreate) created.push(dir);
    }
    const message =
      created.length === 0
        ? `Active/state/config dirs already present`
        : `Created ${created.length} dir(s)`;
    return {
      ok: true,
      name: STEP_CREATE_ACTIVE,
      done: created.length > 0,
      message,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_CREATE_ACTIVE,
      error: errorText(err),
    };
  }
}

export async function stepWriteSchemaVersion(deps: SetupDeps = {}): Promise<StepResult> {
  const { paths } = resolveDeps(deps);
  try {
    const result = await ensureSchemaVersion(paths.activeRoot);
    const message = result.migrated
      ? `Migrated v${result.before} -> v${result.after}`
      : `Schema at v${result.after}`;
    return {
      ok: true,
      name: STEP_SCHEMA,
      done: result.migrated,
      message,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_SCHEMA,
      error: errorText(err),
    };
  }
}

const CONFIG_STUB = {
  discovery: {
    githubRepos: [] as string[],
    localRepos: [] as string[],
    projectsRoot: '~/Documents/projects',
  },
  // MCP push channels loaded on every `aw`/`open` launch, for every
  // initiative — see `utils/global-config.ts`. Edit or clear this list to
  // customize; an empty/missing array falls back to the agent-chat default.
  channels: ['plugin:agent-chat@agent-chat-local'] as string[],
};

export async function stepWriteConfigStub(deps: SetupDeps = {}): Promise<StepResult> {
  const { fs, paths, update } = resolveDeps(deps);
  const configPath = nodePath.join(paths.configRoot, 'config.json');
  try {
    await ensureDir(fs, paths.configRoot);
    let exists = false;
    try {
      await fs.stat(configPath);
      exists = true;
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
    if (exists && !update) {
      return {
        ok: true,
        name: STEP_CONFIG,
        done: false,
        message: `Config exists at ${configPath} (left untouched)`,
      };
    }
    await fs.writeFile(configPath, JSON.stringify(CONFIG_STUB, null, 2) + '\n', 'utf8');
    return {
      ok: true,
      name: STEP_CONFIG,
      done: true,
      message: `Wrote config stub to ${configPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_CONFIG,
      error: errorText(err),
    };
  }
}
