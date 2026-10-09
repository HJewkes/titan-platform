import { createRpcHooks } from "@titan-design/react-app";
import type { ConsoleCommands } from "../../server/commands.js";

/** Hooks typed by the daemon's own command definitions; the import is erased at build. */
export const { useQuery, useEvents, useInvalidate } = createRpcHooks<ConsoleCommands>();
