import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ISOLATED_ENV = ["HOME", "CLAUDE_CONFIG_DIRS", "CLAUDE_TRANSCRIPT_MIRRORS"] as const;

export interface TempHome {
  home: string;
  restore(): void;
}

/** Points HOME at an empty temp dir and clears the variables that would add real config roots. */
export function useTempHome(): TempHome {
  const home = mkdtempSync(path.join(os.tmpdir(), "titan-memory-miner-"));
  const saved = ISOLATED_ENV.map((key) => [key, process.env[key]] as const);
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIRS;
  delete process.env.CLAUDE_TRANSCRIPT_MIRRORS;
  return {
    home,
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function fact(name: string, description: string, body: string, type = "feedback"): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
}

export function writeMemory(configDir: string, project: string, files: Record<string, string>): string {
  const dir = path.join(configDir, "projects", project, "memory");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}
