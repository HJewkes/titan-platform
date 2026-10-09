import type { BaseContext, CommandRegistry, ErrorDescription } from "@titan-design/registry";
import type { RequestAuth } from "./auth.js";

/** Which projection of the registry is running the command. */
export type Surface = "http" | "mcp";

/**
 * What every surface needs to run a command. `createContext` is the seam that keeps this
 * package domain-free: the daemon never knows what a product's context contains. `auth` is
 * what the `gate` recorded, so a command can refuse a credential kind. It is undefined only on
 * an ungated listener and on MCP: a gated app answers 401 rather than call this without it.
 */
export interface SurfaceOptions<Ctx extends BaseContext = BaseContext> {
  registry: CommandRegistry<Ctx>;
  createContext: (surface: Surface, auth?: RequestAuth) => Ctx;
  /** Map a thrown value to a message and code; defaults to the registry's `describeError`. */
  formatError?: (err: unknown) => ErrorDescription;
}
