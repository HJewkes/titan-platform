import type { githubPort } from "@titan-design/github";
import { isPassing } from "@titan-design/github";

export type Port = typeof githubPort;
export const passing = isPassing;
