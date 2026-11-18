/** Setup steps for daemon supervision, the manual daemon start and the ingestion walkthrough. */
import { errorText } from './errors.js';
import { STEP_SUPERVISION } from './supervision-systemd.js';
import { getSupervisor } from './supervision.js';
import { resolveDeps, STEP_DAEMON, STEP_INGEST, type SetupDeps, type StepResult } from './steps-deps.js';

/**
 * Offer to install a user-level supervisor (systemd on Linux, launchd on
 * macOS) that keeps the daemon running across logins. No-op on platforms
 * without an integration.
 */
export async function stepSupervision(deps: SetupDeps = {}): Promise<StepResult> {
  const { prompts, yes } = resolveDeps(deps);
  const supervisor = getSupervisor();
  if (!supervisor) {
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: false,
      message: `Skipped: no daemon supervisor is integrated for ${process.platform}`,
    };
  }
  if (!yes) {
    const answer = await prompts.confirm({
      message: supervisor.installPrompt,
      initialValue: true,
    });
    if (prompts.isCancel(answer) || answer !== true) {
      return {
        ok: true,
        name: STEP_SUPERVISION,
        done: false,
        message: 'Supervision install skipped',
      };
    }
  }
  // Supervision is an optional enhancement, not a prerequisite. Like
  // `stepStartDaemon`, a runtime failure (no user session, container, CI) must
  // not abort the whole setup — the unit/plist is still written, so downgrade
  // an install failure to a non-fatal warning that tells the user how to finish
  // enabling it by hand.
  const result = await supervisor.install(deps);
  if (!result.ok) {
    return {
      ok: true,
      name: STEP_SUPERVISION,
      done: false,
      message: `Daemon supervision not enabled (${result.error}); run \`${supervisor.enableHint}\` once a user session is available`,
    };
  }
  return result;
}

/** Probe the platform supervisor; null when the platform has no integration. */
async function probeSupervisor(deps: SetupDeps): Promise<{ kind: string; active: boolean } | null> {
  const supervisor = getSupervisor();
  if (!supervisor) return null;
  return { kind: supervisor.kind, active: await supervisor.isActive(deps) };
}

/** Spawn `active-work mcp serve --detach` (best-effort). */
export async function stepStartDaemon(deps: SetupDeps = {}): Promise<StepResult> {
  const { spawn, prompts, yes, cliEntry } = resolveDeps(deps);
  // If a supervisor already owns the daemon, skip the manual spawn — restarting
  // it is the supervisor's job (e.g. `systemctl --user restart` / `launchctl
  // kickstart`).
  const probe = deps.supervisorActive ?? (() => probeSupervisor(deps));
  const supervisor = await probe();
  if (supervisor?.active) {
    return {
      ok: true,
      name: STEP_DAEMON,
      done: false,
      message: `Daemon already supervised by ${supervisor.kind}; manual start skipped`,
    };
  }
  if (!yes) {
    const answer = await prompts.confirm({
      message: 'Start the HTTP daemon now? (background process)',
      initialValue: true,
    });
    if (prompts.isCancel(answer) || answer !== true) {
      return {
        ok: true,
        name: STEP_DAEMON,
        done: false,
        message: 'Daemon start skipped',
      };
    }
  } else {
    return {
      ok: true,
      name: STEP_DAEMON,
      done: false,
      message: 'Daemon start skipped (--yes)',
    };
  }
  try {
    const child = spawn(process.execPath, [cliEntry, 'mcp', 'serve', '--detach'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return {
      ok: true,
      name: STEP_DAEMON,
      done: true,
      message: `Daemon launched (pid=${child.pid ?? 'unknown'})`,
    };
  } catch (err) {
    return {
      ok: true,
      name: STEP_DAEMON,
      done: false,
      message: `Daemon launch skipped: ${errorText(err)}`,
    };
  }
}

export async function stepIngestion(deps: SetupDeps = {}): Promise<StepResult> {
  const { prompts, yes, paths } = resolveDeps(deps);
  if (yes) {
    return {
      ok: true,
      name: STEP_INGEST,
      done: false,
      message:
        `Skipped ingestion walkthrough. Run \`claude\` in ${paths.activeRoot} ` +
        'and ask it to run `active-work discover` followed by `active-work fold` / `active-work drop` / `active-work track`.',
    };
  }
  const answer = await prompts.confirm({
    message: 'Walk through existing work with Claude now?',
    initialValue: false,
  });
  if (prompts.isCancel(answer) || answer !== true) {
    return {
      ok: true,
      name: STEP_INGEST,
      done: false,
      message:
        `Ingestion skipped. Later: run \`claude\` in ${paths.activeRoot} and ask it to ` +
        'invoke `active-work discover` to scan your work.',
    };
  }
  return {
    ok: true,
    name: STEP_INGEST,
    done: true,
    message:
      `Run \`claude\` in ${paths.activeRoot} and paste this prompt: ` +
      '"Please run `active-work discover`, then walk me through `active-work fold` / `active-work drop` / `active-work track` for each hit."',
  };
}
