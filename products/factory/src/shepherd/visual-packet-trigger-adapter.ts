import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultTitanReviewBin = (): string => join(process.env.HOME || homedir(), ".local", "bin", "titan-review");

export const makePacketDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};
