import { createRpcHooks } from "@titan-design/react-app";
import type { CommandMapOf } from "@titan-design/registry";
import type { consoleCommands } from "../../server/commands.js";

/** Required: a source the daemon may leave unwired (reviews, host reports) spreads its commands as optional keys, which `CommandMapOf` maps to never. */
export type ServedCommands = CommandMapOf<Required<ReturnType<typeof consoleCommands>>>;

/** Hooks typed by the daemon's own command definitions; the import is erased at build. */
export const { useQuery, useEvents, useInvalidate } = createRpcHooks<ServedCommands>();
