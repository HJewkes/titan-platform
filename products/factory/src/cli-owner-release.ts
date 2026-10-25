import { EXIT as SYSEXITS } from "@titan-design/registry";
import type { Command } from "commander";
import type { CliIo, Verbs } from "./cli.js";
import { EXIT } from "./exit-codes.js";
import { ownerResolver } from "./gate-resolve.js";
import type { FactoryHost, FactoryRoutes } from "./host.js";
import { parsePrRef } from "./registry.js";
import { ownerHeldAt, ownerHeldRun, ownerRelease } from "./shepherd/owner-release.js";
import { ReleaseHeadArg } from "./shepherd/release-head.js";

/**
 * `shepherd owner-release`: a local verb on this host's database, like `gate resolve`, and never a registry command, so no
 * rpc, MCP or registry caller reaches it. Its resolver is `ownerResolver`, so an agent-chat shell needs an owner-signed hold-release statement.
 */
export function registerOwnerRelease(shepherd: Command, { io, withHost }: Verbs): void {
  shepherd
    .command("owner-release <ref>")
    .description("release the owner-asked hold on owner/repo#N at --head; local only, the owner's own terminal, never over rpc or MCP")
    .requiredOption("--head <sha>", "the 40-character head sha the owner releases at; refused when the PR is at another")
    .action((ref: string, opts: { head: string }) => withHost((host, routes) => runOwnerRelease(io, host, routes, ref, opts.head)));
}

async function runOwnerRelease(io: CliIo, host: FactoryHost, routes: FactoryRoutes, ref: string, head: string): Promise<number> {
  const target = parseTarget(ref, head);
  if (typeof target === "string") return fail(io, target, EXIT.USAGE);
  if (!routes.shepherd) return fail(io, "this host runs no Shepherd, so there is no hold to release", EXIT.UNAVAILABLE);
  const { store: storeRef, port } = routes.shepherd;
  const at = { ...target, head };
  try {
    const { runId } = ownerHeldRun(storeRef.get(), target.repo, target.pr);
    const held = ownerHeldAt(storeRef.get(), runId, at);
    const resolver = await ownerResolver(io.env, host.batches, held, `release the owner-asked hold on ${target.repo}#${target.pr} at ${head}`);
    if (typeof resolver === "string") return fail(io, `${resolver}; nothing was released`, SYSEXITS.NOPERM);
    const after = await ownerRelease(storeRef.get(), port, at, resolver, host.batches);
    io.stdout(`released the owner-asked hold on ${target.repo}#${target.pr} at ${head} as ${resolver.class} ${resolver.id}${after.held ? `; still held: ${after.holdReason ?? "held"}` : ""}\n`);
    return EXIT.OK;
  } catch (err) {
    return fail(io, messageOf(err), exitOf(err));
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The sysexits code a refusal carries; any other error is a plain failure. */
function exitOf(err: unknown): number {
  const code: unknown = err instanceof Error && "code" in err ? err.code : undefined;
  return typeof code === "number" && Number.isInteger(code) ? code : EXIT.FAILURE;
}

function parseTarget(ref: string, head: string): ReturnType<typeof parsePrRef> | string {
  if (!ReleaseHeadArg.safeParse(head).success) return `--head must be the 40-character head sha, got ${JSON.stringify(head)}`;
  try {
    return parsePrRef(ref);
  } catch (err) {
    return messageOf(err);
  }
}

function fail(io: CliIo, message: string, code: number): number {
  io.stderr(`error: ${message}\n`);
  return code;
}
