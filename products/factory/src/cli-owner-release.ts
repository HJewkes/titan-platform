import { EXIT as SYSEXITS } from "@titan-design/registry";
import type { Command } from "commander";
import type { CliIo, Verbs } from "./cli.js";
import { EXIT } from "./exit-codes.js";
import { ownerResolver, type OwnerPresence } from "./gate-resolve.js";
import type { FactoryRoutes } from "./host.js";
import { confirmOwner } from "./owner-presence.js";
import { parsePrRef } from "./registry.js";
import { ownerHeldRun, ownerRelease } from "./shepherd/owner-release.js";
import { ReleaseHeadArg } from "./shepherd/release-head.js";

/**
 * `shepherd owner-release`: a local verb on this host's database, like `gate resolve`, and never a registry command, so no
 * rpc, MCP or registry caller reaches it. Its resolver is `ownerResolver`, so an agent-chat shell needs the owner's presence.
 */
export function registerOwnerRelease(shepherd: Command, { io, deps, withHost }: Verbs): void {
  shepherd
    .command("owner-release <ref>")
    .description("release the owner-asked hold on owner/repo#N at --head; local only, the owner's own terminal, never over rpc or MCP")
    .requiredOption("--head <sha>", "the 40-character head sha the owner releases at; refused when the PR is at another")
    .action((ref: string, opts: { head: string }) => withHost((_host, routes) => runOwnerRelease(io, routes, ref, opts.head, deps.presence ?? confirmOwner)));
}

async function runOwnerRelease(io: CliIo, routes: FactoryRoutes, ref: string, head: string, presence: OwnerPresence): Promise<number> {
  const target = parseTarget(ref, head);
  if (typeof target === "string") return fail(io, target, EXIT.USAGE);
  if (!routes.shepherd) return fail(io, "this host runs no Shepherd, so there is no hold to release", EXIT.UNAVAILABLE);
  const { store: storeRef, port } = routes.shepherd;
  try {
    ownerHeldRun(storeRef.get(), target.repo, target.pr);
    const resolver = await ownerResolver(io.env, `release the owner-asked hold on ${target.repo}#${target.pr} at ${head}`, presence);
    if (typeof resolver === "string") return fail(io, `${resolver}; nothing was released`, SYSEXITS.NOPERM);
    const after = await ownerRelease(storeRef.get(), port, { ...target, head }, resolver);
    io.stdout(`released the owner-asked hold on ${target.repo}#${target.pr} at ${head} as ${resolver.class} ${resolver.id}${after.held ? `; still held: ${after.holdReason ?? "held"}` : ""}\n`);
    return EXIT.OK;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return fail(io, (err as Error).message, Number.isInteger(code) ? (code as number) : EXIT.FAILURE);
  }
}

function parseTarget(ref: string, head: string): ReturnType<typeof parsePrRef> | string {
  if (!ReleaseHeadArg.safeParse(head).success) return `--head must be the 40-character head sha, got ${JSON.stringify(head)}`;
  try {
    return parsePrRef(ref);
  } catch (err) {
    return (err as Error).message;
  }
}

function fail(io: CliIo, message: string, code: number): number {
  io.stderr(`error: ${message}\n`);
  return code;
}
