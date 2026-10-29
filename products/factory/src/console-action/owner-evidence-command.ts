import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { ownerEvidence, type OwnerEvidence } from "./owner-evidence.js";

const fail = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** The console's read-back for an owner-at-head merge gate: the evidence its card shows and the digest a tap must post back. */
export const gateOwnerEvidence = defineCommand<{ gateId: string }, OwnerEvidence, FactoryContext>({
  name: "gate.ownerEvidence",
  description:
    "The evidence an owner-at-head approve-merge gate needs before the console may answer it, read live at the gate's pinned head: per fact, the changed files against the merge base and, for a CI-policy fact, the reviewer's verdict text; with the digest a console tap must carry, or why the card cannot show it; reads only",
  args: z.object({ gateId: z.string().min(1).max(512) }),
  result: z.custom<OwnerEvidence>(),
  run: async ({ gateId }, ctx) => {
    const gate = ctx.host.gates.get(gateId);
    if (gate === undefined) throw fail(`no gate ${gateId}`, EXIT.NOINPUT);
    if (ctx.shepherd === undefined) throw fail("reading a gate's evidence needs the shepherd routes", EXIT.UNAVAILABLE);
    return ownerEvidence(gate, { host: ctx.host, port: ctx.shepherd.port });
  },
});
