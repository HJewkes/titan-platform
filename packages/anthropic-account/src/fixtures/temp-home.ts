import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

// Every node test works in a fresh temp dir passed in explicitly, so no test can reach a
// real `~/.claude` or `~/.claude-profiles` credentials file.
export function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-account-"));
}

export function removeTempHome(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
}

export function writeFileWithMode(file: string, text: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
}

// Captures everything the console and both standard streams are given while a test runs.
export function captureOutput(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const record = (...args: unknown[]): void => {
    chunks.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(" "));
  };
  const spies = [
    ...(["log", "info", "warn", "error", "debug", "trace"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(record),
    ),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (record(chunk), true)),
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (record(chunk), true)),
  ];
  return { text: () => chunks.join("\n"), restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [error.message, error.name, error.stack ?? "", String(error.cause ?? "")].join("\n");
}

export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}
