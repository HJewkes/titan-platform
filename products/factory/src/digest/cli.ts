import { probeHealth } from "@titan-design/daemon";
import { invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import type { Command } from "commander";
import { parsePort } from "../cli-options.js";
import type { FactoryHost, FactoryRoutes } from "../host.js";
import { createFactoryRegistry, factoryContext } from "../registry.js";
import { FACTORY_PORT } from "../serve.js";
import { parseSinceOption, runDigestVerb, type DigestFlags, type DigestIo, type FactoryCall } from "./command.js";

export interface DigestVerbs {
  io: DigestIo;
  withHost: (fn: (host: FactoryHost, routes: FactoryRoutes) => Promise<number> | number) => Promise<void>;
  setExit: (code: number) => void;
}

export type FactoryRpc = (port: number, name: string, args: unknown) => Promise<JsonEnvelope<unknown>>;

/** Reads Shepherd and the gates from titan-factory serve when one answers, else from the database here. */
export function registerDigest(program: Command, verbs: DigestVerbs, rpc: FactoryRpc): void {
  program
    .command("digest")
    .description("the owner digest across every coordinator seat")
    .command("run")
    .description("collect and render the digest for the current slot, then write <date>-<HH>.md to the digest and iCloud dirs")
    .option("--since <window>", "window like 90m, 6h or 2d; default runs back to the previous slot", parseSinceOption)
    .option("--dry-run", "print the markdown and write nothing")
    .option("--full", "show every ask, merged and stuck item instead of the top few")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action(async (opts: { since?: number; dryRun?: boolean; full?: boolean; port: number }) => {
      const flags: DigestFlags = { sinceMinutes: opts.since, dryRun: opts.dryRun, full: opts.full };
      if (await probeHealth(opts.port)) return verbs.setExit(await runDigestVerb(verbs.io, (name, args) => rpc(opts.port, name, args), flags));
      await verbs.withHost((host, routes) => {
        const call: FactoryCall = async (name, args) => (await invokeCommand(createFactoryRegistry().get(name)!, args, factoryContext(host, routes))).envelope;
        return runDigestVerb(verbs.io, call, flags);
      });
    });
}
