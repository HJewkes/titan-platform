import { relative } from "node:path";

// A test file that never yields its worker's event loop, such as a poll whose fake sleep resolves at once under a
// frozen clock, never reaches testTimeout: vitest waits on it forever and prints nothing (TP-4287 sat 74 minutes).
// The main thread stays free, so this reporter names the file and fails the run. The slowest green file takes under
// 3 minutes on a hosted runner.
export const FILE_LIMIT_MS = 15 * 60_000;
const CHECK_MS = 30_000;

/** The files that started at least `limitMs` before `now` and have not ended. */
export function overdueFiles(started, now, limitMs) {
  return [...started].filter(([, at]) => now - at >= limitMs).map(([file]) => file);
}

const fileOf = (testModule) => `${testModule.project.name} ${relative(process.cwd(), testModule.moduleId)}`;

export default class FileWatchdog {
  started = new Map();

  constructor({ limitMs = FILE_LIMIT_MS, now = Date.now, log = console.error, exit = (code) => process.exit(code) } = {}) {
    Object.assign(this, { limitMs, now, log, exit });
  }

  onInit() {
    this.timer = setInterval(() => this.check(), CHECK_MS);
    this.timer.unref();
  }

  onTestModuleQueued(testModule) {
    this.started.set(fileOf(testModule), this.now());
  }

  onTestModuleEnd(testModule) {
    this.started.delete(fileOf(testModule));
  }

  onTestRunEnd() {
    clearInterval(this.timer);
  }

  check() {
    const overdue = overdueFiles(this.started, this.now(), this.limitMs);
    if (overdue.length === 0) return;
    const minutes = this.limitMs / 60_000;
    this.log(`file watchdog: still running after ${minutes} min, so its worker never yielded:\n  ${overdue.join("\n  ")}`);
    this.exit(1);
  }
}
