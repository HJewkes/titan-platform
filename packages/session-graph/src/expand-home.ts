import path from "node:path";

/** Expands a leading `~/` or a bare `~`; stored source keys can carry either. */
export function expandHome(file: string, homeDir: string): string {
  if (file === "~") return homeDir;
  return file.startsWith("~/") ? path.join(homeDir, file.slice(2)) : file;
}
