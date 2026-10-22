import type { Decision } from "@titan-design/authority";
import type { GitHubPort } from "@titan-design/github";
import type { GateStatus } from "@titan-design/hitl";
import { ownerOpSchema, type OwnerOp, type OwnerOpKind } from "@titan-design/owner-queue";
import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import { landGate } from "../coordinator-evidence.js";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import type { ShepherdStore } from "../shepherd/store.js";
import { opAuthority } from "./authority.js";

interface PrPreview {
  repo: string;
  pr: number;
  state: "open" | "merged" | "closed";
  title: string | null;
  base: string;
  /** Only while the PR is open: a merged or closed PR has no head left to act at. */
  head?: string;
  mergeSha?: string;
  behind: boolean;
  mergeableState: string;
  shepherd: { runId: string; held: boolean; holdReason: string | null; ownerHold: string | null } | null;
}

interface GatePreview {
  gateId: string;
  status: GateStatus | "missing";
  /** The PR and head the gate asks about, when it reads as an approve-merge gate. */
  asks?: { repo: string; pr: number; head: string };
}

export interface OpPreview {
  kind: OwnerOpKind;
  authority: Decision;
  pr?: PrPreview;
  gate?: GatePreview;
}

type PrOp = Extract<OwnerOp, { repo: string; pr: number }>;
const isPrOp = (op: OwnerOp): op is PrOp => "pr" in op;

/**
 * The live read-back for an op, built only from the systems of record: the authority table, GitHub and Shepherd for a PR, the
 * gate store for a gate. Nothing in it comes from the op but the target, so a deposit that names a stale head reads back the true one.
 */
async function previewOp(op: OwnerOp, ctx: FactoryContext): Promise<OpPreview> {
  const base = { kind: op.kind, authority: opAuthority(op) };
  if (op.kind === "resolve-gate") return { ...base, gate: gatePreview(ctx.host, op.gateId) };
  if (!isPrOp(op)) return base;
  if (ctx.shepherd === undefined) throw Object.assign(new Error(`previewing a ${op.kind} op needs the shepherd routes`), { code: EXIT.UNAVAILABLE });
  return { ...base, pr: await prPreview(ctx.shepherd.port, ctx.shepherd.store.get(), op) };
}

async function prPreview(port: GitHubPort, store: ShepherdStore, { repo, pr }: PrOp): Promise<PrPreview> {
  const pull = await port.getPr(repo, pr);
  const state = pull.state === "open" ? "open" : pull.merged ? "merged" : "closed";
  const registration = store.byPr(repo, pr);
  return {
    repo,
    pr,
    state,
    title: pull.title ?? null,
    base: pull.baseRef,
    ...(state === "open" && { head: pull.headSha }),
    ...(state === "merged" && pull.mergeSha !== null && { mergeSha: pull.mergeSha }),
    behind: pull.behind,
    mergeableState: pull.mergeableState,
    shepherd: registration
      ? { runId: registration.runId, held: registration.held, holdReason: registration.holdReason, ownerHold: registration.ownerHold?.reason ?? null }
      : null,
  };
}

function gatePreview(host: FactoryHost, gateId: string): GatePreview {
  const gate = host.gates.get(gateId);
  if (gate === undefined) return { gateId, status: "missing" };
  const land = landGate(gate);
  return { gateId, status: gate.status, ...(land && { asks: { repo: land.repo, pr: land.pr, head: land.head } }) };
}

export const ownerOpPreview = defineCommand<{ op: OwnerOp }, OpPreview, FactoryContext>({
  name: "owner-op.preview",
  description: "The live read-back for one typed owner op: its authority decision for owner-remote and the PR or gate it names, as GitHub, Shepherd and the gate store say now; reads only",
  args: z.object({ op: ownerOpSchema }),
  result: z.custom<OpPreview>(),
  run: async ({ op }, ctx) => previewOp(op, ctx),
});
