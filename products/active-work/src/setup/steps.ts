/**
 * `active-work setup`: runs every setup step in order. The steps live in the
 * `steps-*.ts` modules; uninstall lives in `uninstall.ts`.
 */
import type { SetupDeps } from './steps-deps.js';
import { stepCheckNode, stepCreateActiveRoot, stepWriteSchemaVersion, stepWriteConfigStub } from './steps-local.js';
import { stepInstallSkill, stepInstallCommand } from './steps-install.js';
import { stepRegisterMcp, stepRegisterAgentChatHooks } from './steps-register.js';
import { stepSupervision, stepStartDaemon, stepIngestion } from './steps-daemon.js';

export type { SetupDeps, StepPaths, StepResult } from './steps-deps.js';

export interface SetupReport {
  banner: string;
  steps: Array<{
    name: string;
    ok: boolean;
    done?: boolean;
    message?: string;
    error?: string;
  }>;
}

/** Run every setup step in order, short-circuiting on the first failure. */
export async function runSetup(deps: SetupDeps = {}): Promise<SetupReport> {
  const banner = 'active-work setup';
  const steps: SetupReport['steps'] = [];
  const ordered = [
    stepCheckNode,
    stepCreateActiveRoot,
    stepWriteSchemaVersion,
    stepWriteConfigStub,
    stepInstallSkill,
    stepInstallCommand,
    stepRegisterMcp,
    stepRegisterAgentChatHooks,
    stepSupervision,
    stepStartDaemon,
    stepIngestion,
  ];
  for (const step of ordered) {
    const result = await step(deps);
    if (result.ok) {
      steps.push({
        name: result.name,
        ok: true,
        done: result.done,
        message: result.message,
      });
    } else {
      steps.push({ name: result.name, ok: false, error: result.error });
      break;
    }
  }
  return { banner, steps };
}
