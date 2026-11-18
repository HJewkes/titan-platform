/** Setup steps that copy the bundled skill and /aw-prompt command into ~/.claude. */
import nodePath from 'node:path';
import { errorText } from './errors.js';
import {
  copyTree,
  pathExists,
  resolveDeps,
  STEP_COMMAND,
  STEP_SKILL,
  type SetupDeps,
  type StepResult,
} from './steps-deps.js';

export async function stepInstallSkill(deps: SetupDeps = {}): Promise<StepResult> {
  const { fs, paths, repoRoot } = resolveDeps(deps);
  const targetDir = nodePath.join(paths.homeDir, '.claude', 'skills', 'active-work');
  const targetMarker = nodePath.join(targetDir, 'SKILL.md');
  const sourceDir = nodePath.join(repoRoot, 'skill');
  try {
    if (await pathExists(fs, targetMarker)) {
      return {
        ok: true,
        name: STEP_SKILL,
        done: false,
        message: `Skill already installed at ${targetDir}`,
      };
    }
    if (!(await pathExists(fs, sourceDir))) {
      return {
        ok: true,
        name: STEP_SKILL,
        done: false,
        message: `Skill source not found at ${sourceDir}; skipping`,
      };
    }
    await fs.mkdir(nodePath.dirname(targetDir), { recursive: true });
    await copyTree(fs, sourceDir, targetDir);
    return {
      ok: true,
      name: STEP_SKILL,
      done: true,
      message: `Installed skill to ${targetDir}`,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_SKILL,
      error: errorText(err),
    };
  }
}

export async function stepInstallCommand(deps: SetupDeps = {}): Promise<StepResult> {
  const { fs, paths, repoRoot } = resolveDeps(deps);
  const targetDir = nodePath.join(paths.homeDir, '.claude', 'commands');
  const target = nodePath.join(targetDir, 'aw-prompt.md');
  const source = nodePath.join(repoRoot, 'claude-commands', 'aw-prompt.md');
  try {
    if (!(await pathExists(fs, source))) {
      return {
        ok: true,
        name: STEP_COMMAND,
        done: false,
        message: `Command source not found at ${source}; skipping`,
      };
    }
    await fs.mkdir(targetDir, { recursive: true });
    // Overwrite unconditionally (unlike the skill step, which skips if present):
    // the command is a single version-bundled file, so setup should refresh it.
    await fs.copyFile(source, target);
    return {
      ok: true,
      name: STEP_COMMAND,
      done: true,
      message: `Installed /aw-prompt command to ${target}`,
    };
  } catch (err) {
    return {
      ok: false,
      name: STEP_COMMAND,
      error: errorText(err),
    };
  }
}
