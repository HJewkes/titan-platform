import { configPath, loadConfig } from "../config.js";
import { boundCheckout, loadSeatBook } from "./seats.js";

/** The checkout a seat binds to `repo`, else its `shepherd.repos` path, re-read per wake as the reviewer's spawn re-reads it. */
export function seatCheckout(env: NodeJS.ProcessEnv = process.env): (repo: string) => string | undefined {
  return (repo) => {
    const shepherd = loadConfig(configPath(env)).shepherd ?? {};
    return boundCheckout(loadSeatBook(shepherd), repo, shepherd.repos);
  };
}
