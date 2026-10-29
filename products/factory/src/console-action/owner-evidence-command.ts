import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryContext } from "../registry.js";
import { ownerEvidence, type OwnerEvidence } from "./owner-evidence.js";

const fail = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** The console's read-back for an owner-at-head merge gate: the card its stored evidence shows, or why it cannot show one. */
export const gateOwnerEvidence = defineCommand<{ gateId: string }, OwnerEvidence, FactoryContext>({
  name: "gate.ownerEvidence",
  description:
    "The evidence card for an owner-at-head approve-merge gate, projected from the merge evidence the gate was opened on: its facts, which must equal the gate's marker; for a CI-policy fact the stored reading beside the reviewer's verdict text; and each changed file the fact covers, pinned by blob sha and shown exactly against the merge base; or why the card cannot show it, with the terminal command; reads only",
  args: z.object({ gateId: z.string().min(1).max(512) }),
  result: z.custom<OwnerEvidence>(),
  run: async ({ gateId }, ctx) => {
    const gate = ctx.host.gates.get(gateId);
    if (gate === undefined) throw fail(`no gate ${gateId}`, EXIT.NOINPUT);
    if (ctx.shepherd === undefined) throw fail("reading a gate's file evidence needs the shepherd routes", EXIT.UNAVAILABLE);
    return ownerEvidence(gate, { host: ctx.host, port: ctx.shepherd.port });
  },
});
