import type { BaseContext, CommandRegistry, ErrorDescription } from "@titan-design/registry";

/** Which projection of the registry is running the command. */
export type Surface = "http" | "mcp";

/**
 * What every surface needs to run a command. `createContext` is the seam that keeps this
 * package domain-free: the daemon never knows what a product's context contains.
 */
export interface SurfaceOptions<Ctx extends BaseContext = BaseContext> {
  registry: CommandRegistry<Ctx>;
  createContext: (surface: Surface) => Ctx;
  /** Map a thrown value to a message and code; defaults to the registry's `describeError`. */
  formatError?: (err: unknown) => ErrorDescription;
}
