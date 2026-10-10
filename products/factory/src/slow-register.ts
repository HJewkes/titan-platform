import type { Logger } from "@titan-design/daemon";
import type { AnyCommand } from "@titan-design/registry";
import type { FactoryContext } from "./registry.js";

const SLOW_REGISTER_MS = 5000;

/** A register that takes this long is what makes a client's /health probe time out, so serve says so. */
export function logSlowRegister<C extends AnyCommand<FactoryContext>>(cmd: C, log: Logger, now: () => number = Date.now): C {
  if (cmd.name !== "shepherd.register") return cmd;
  return {
    ...cmd,
    async run(args: { repo?: string }, ctx: FactoryContext) {
      const started = now();
      try {
        return await cmd.run(args, ctx);
      } finally {
        const elapsedMs = now() - started;
        if (elapsedMs > SLOW_REGISTER_MS) log.warn({ command: cmd.name, repo: args.repo, elapsedMs }, "shepherd register was slow");
      }
    },
  };
}
