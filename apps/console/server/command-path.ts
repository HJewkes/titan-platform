import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** Whether `file` is a regular file this process may execute; a seam for tests. */
export type IsExecutable = (file: string) => boolean;

export const hostIsExecutable: IsExecutable = (file) => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * A bare command name resolved on `pathVar` the way a shell would, first match winning; null when no entry holds it.
 * A value with a separator is returned unchanged, so a relative path still meets the send-time absolute-path refusal.
 */
export function resolveCommand(command: string, pathVar: string | undefined, isExecutable: IsExecutable): string | null {
  if (command.includes("/") || command.includes(path.sep)) return command;
  const dirs = (pathVar ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  for (const dir of dirs) {
    const file = path.join(dir, command);
    if (isExecutable(file)) return file;
  }
  return null;
}
