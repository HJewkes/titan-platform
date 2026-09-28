import { describe, expect, it } from "vitest";
import { foldResolution, type FoldContext } from "./fold.js";
import type { ItemKind } from "./item.js";
import type { MatrixEvent } from "./types.js";

const OWNER = "@owner:hub.test";
const STRANGER = "@ac-edge1-a:hub.test";

const items = new Map<string, ItemKind>([
  ["$appr", "approval_request"],
  ["$endorse", "endorse_request"],
  ["$question", "question"],
  ["$notice", "notice"],
  ["$message", "message"],
]);
const ctx: FoldContext = { ownerUserId: OWNER, itemEventIds: items };

let seq = 0;
const reaction = (target: string, key: string, sender = OWNER): MatrixEvent => ({
  type: "m.reaction",
  event_id: `$r${seq++}`,
  sender,
  content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } },
});
const reply = (target: string, body: string, sender = OWNER): MatrixEvent => ({
  type: "m.room.message",
  event_id: `$m${seq++}`,
  sender,
  content: { msgtype: "m.text", body, "m.relates_to": { "m.in_reply_to": { event_id: target } } },
});
const decision = (target: string, content: Record<string, unknown>): MatrixEvent => ({
  type: "io.titan.resolution",
  event_id: `$d${seq++}`,
  sender: OWNER,
  content: { ...content, "m.relates_to": { rel_type: "m.reference", event_id: target } },
});

describe("foldResolution, section 4.3 table from the owner", () => {
  it.each([
    ["$appr", "✅", "allow"],
    ["$appr", "👍", "allow"],
    ["$appr", "👍🏽", "allow"],
    ["$appr", "❌", "deny"],
    ["$appr", "👎", "deny"],
    ["$endorse", "✅", "approve"],
    ["$endorse", "👍", "approve"],
    ["$endorse", "❌", "dismiss"],
    ["$endorse", "👎", "dismiss"],
    ["$notice", "✅", "dismiss"],
    ["$notice", "❌", "dismiss"],
    ["$message", "✅", "dismiss"],
  ])("reaction on %s with %s folds to %s", (target, key, verdict) => {
    expect(foldResolution(reaction(target, key), ctx)).toEqual({ itemEventId: target, verdict });
  });

  it.each([
    ["$appr", "allow", "allow"],
    ["$appr", "  DENY \n", "deny"],
    ["$appr", "approve", "allow"],
    ["$endorse", "Approve", "approve"],
    ["$endorse", "dismiss", "dismiss"],
    ["$notice", "dismiss", "dismiss"],
    ["$question", "dismiss", "dismiss"],
  ])("reply to %s saying %j folds to %s", (target, body, verdict) => {
    expect(foldResolution(reply(target, body), ctx)).toEqual({ itemEventId: target, verdict });
  });

  it("reads the verdict word from the last line after a reply fallback", () => {
    const body = "> <@ac-edge1:hub.test> APPR from tp-coord (edge1)\n> Bash: ls\n\nlooks fine\nallow";

    expect(foldResolution(reply("$appr", body), ctx)).toEqual({ itemEventId: "$appr", verdict: "allow" });
  });

  it("treats any other reply to a question as its answer", () => {
    const body = "> <@ac-edge1:hub.test> QUESTION\n\nuse the main branch";

    expect(foldResolution(reply("$question", body), ctx)).toEqual({ itemEventId: "$question", verdict: "answer", text: "use the main branch" });
  });

  it("accepts an io.titan.resolution decision from the owner", () => {
    expect(foldResolution(decision("$appr", { decision: "deny" }), ctx)).toEqual({ itemEventId: "$appr", verdict: "deny" });
    expect(foldResolution(decision("$question", { decision: "answer", text: "yes" }), ctx)).toEqual({ itemEventId: "$question", verdict: "answer", text: "yes" });
  });
});

describe("foldResolution rejects", () => {
  it("the same reaction from another sender", () => {
    expect(foldResolution(reaction("$appr", "✅", STRANGER), ctx)).toBeNull();
  });

  it("a reply to an unknown event", () => {
    expect(foldResolution(reply("$elsewhere", "allow"), ctx)).toBeNull();
  });

  it("a 👍 on a non-item", () => {
    expect(foldResolution(reaction("$not-an-item", "👍"), ctx)).toBeNull();
  });

  it("an unaccepted emoji, and a reaction on a question", () => {
    expect(foldResolution(reaction("$appr", "🎉"), ctx)).toBeNull();
    expect(foldResolution(reaction("$question", "✅"), ctx)).toBeNull();
  });

  it("free text on an approval, and a decision that does not fit the kind", () => {
    expect(foldResolution(reply("$appr", "maybe later"), ctx)).toBeNull();
    expect(foldResolution(decision("$appr", { decision: "answer", text: "x" }), ctx)).toBeNull();
  });

  it("a message that relates to an item without replying to it", () => {
    const edit: MatrixEvent = { type: "m.room.message", event_id: "$e", sender: OWNER, content: { body: "allow", "m.relates_to": { rel_type: "m.replace", event_id: "$appr" } } };

    expect(foldResolution(edit, ctx)).toBeNull();
  });
});
