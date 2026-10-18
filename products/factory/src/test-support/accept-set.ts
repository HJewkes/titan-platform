import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterDigest, type AfterDigest } from "../approved-set.js";
import { defineWorkflow } from "../definition.js";
import { visualAcceptDecision } from "../gate-brief.js";
import { deliveryFileFor } from "../shepherd/visual-delivery.js";
import { packetDirFor } from "../shepherd/visual-packet-trigger.js";

/** Synthetic after images; `k3` is the removed one and has none. */
export const AFTER_BYTES: Record<string, Buffer> = { k1: Buffer.from("synthetic after one"), k2: Buffer.from("synthetic after two") };
const ACCEPT_PACKET_ID = "p-accept";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const COMPONENT = "packages/ui/specimen/baseline/";
export const STORY = "packages/ui/tests/visual/reference/stories.spec.ts-snapshots/";

export const setImage = (key: string, layer: string, path: string, change: string) => ({ key, layer, path, change, ...(AFTER_BYTES[key] && { after: { sha256: sha256(AFTER_BYTES[key]) } }) });

/** Out of path order, so the set's sort shows. */
export const acceptImages = () => [
  setImage("k2", "story", `${STORY}two.png`, "new"),
  setImage("k1", "component", `${COMPONENT}one.png`, "changed"),
  setImage("k3", "component", `${COMPONENT}gone.png`, "removed"),
];

export function acceptPacket(where: { repo: string; pr: number; headSha: string; headTree: string }, images: object[] = acceptImages()): Uint8Array {
  return Buffer.from(JSON.stringify({ schema: "titan-review/ci-packet@1", packetId: ACCEPT_PACKET_ID, ...where, ci: { runId: "9001" }, images }));
}

export const afterDigests = (): Map<string, AfterDigest> => new Map(Object.entries(AFTER_BYTES).map(([key, bytes]) => [key, afterDigest(bytes)]));

/** The factory's packet dir for the head as the delivery sweep leaves it, with its delivery record unless `delivery` is null. */
export function writeFactoryPacket(stateDir: string, runId: string, packet: Uint8Array, headSha: string, delivery: object | null = { state: "delivered", packetId: ACCEPT_PACKET_ID, roundId: "r-1" }): void {
  const dir = packetDirFor(stateDir, runId, headSha);
  mkdirSync(join(dir, "after"), { recursive: true });
  writeFileSync(join(dir, "packet.json"), packet);
  for (const [key, bytes] of Object.entries(AFTER_BYTES)) writeFileSync(join(dir, "after", `${key}.png`), bytes);
  if (delivery) writeFileSync(deliveryFileFor(stateDir, runId, headSha), JSON.stringify(delivery));
}

/** Opens one `sh-visual-accept` gate at param `head`, as Shepherd's ci-failed route asks it. */
export const visualAcceptGate = (repo: string) =>
  defineWorkflow({
    name: "visual-accept-gate",
    steps: [{ id: "sh-visual-accept", kind: "assisted" }],
    run: async (ctx) => {
      const pr = Number(ctx.param("pr"));
      const headSha = ctx.param("head")!;
      const { schema, brief } = visualAcceptDecision({ repo, pr, headSha, check: "visual" });
      await ctx.assisted("sh-visual-accept", `Accept the regenerated baselines of PR #${pr} in ${repo} at head ${headSha}? CI is red only on visual.`, { schema, brief });
    },
  });
