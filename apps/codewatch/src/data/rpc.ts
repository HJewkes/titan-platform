import type { CodeReadCommandMap } from "@titan-design/code-read/query";
import { createRpcHooks } from "@titan-design/react-app";

/** Hooks typed by code-read's contract, the single source of command names, args, and results. */
export const { useQuery, useEvents } = createRpcHooks<CodeReadCommandMap>();
