import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_SET_FILES, acceptSetNote, approvedSetOf, gitBlobId, type BuiltSet } from "./approved-set.js";
import { AFTER_BYTES, acceptPacket, afterDigests } from "./test-support/accept-set.js";

const H = "a".repeat(40);
const where = { repo: "example-org/example-repo", pr: 7, headSha: H, headTree: "c".repeat(40) };
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function build(packet = acceptPacket(where), after = afterDigests()) {
  return approvedSetOf({ packet, packetSha: sha256(packet), fromHead: H, after });
}

describe("approvedSetOf", () => {
  it("lists changed and new images by path with their after sha256 and blob id, removed ones by path, and no side paths", () => {
    const built = build();

    const files = [
      { path: "a/one.png", key: "k1", sha256: sha256(AFTER_BYTES.k1!), blob: gitBlobId(AFTER_BYTES.k1!) },
      { path: "b/two.png", key: "k2", sha256: sha256(AFTER_BYTES.k2!), blob: gitBlobId(AFTER_BYTES.k2!) },
    ];
    expect(built).toEqual({ layers: ["component", "story"], set: { packetSha: sha256(acceptPacket(where)), packetId: "p-accept", ciRunId: "9001", fromHead: H, files, removed: ["c/gone.png"], sidePaths: [] } });
    expect(gitBlobId(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("refuses an after image whose bytes do not hash to the packet's after.sha256", () => {
    const after = afterDigests();
    after.set("k2", { sha256: sha256(Buffer.from("other bytes")), blob: gitBlobId(Buffer.from("other bytes")) });

    expect(build(acceptPacket(where), after)).toMatchObject({ reason: "packet", detail: "after/k2.png does not hash to the packet's after.sha256" });
  });

  it(`refuses set-too-large past ${MAX_SET_FILES} kept images`, () => {
    const packet = JSON.parse(Buffer.from(acceptPacket(where)).toString("utf8")) as { images: object[] };
    packet.images = Array.from({ length: MAX_SET_FILES + 1 }, (_, n) => ({ key: `k${n}`, layer: "story", path: `p/${n}.png`, change: "new", after: { sha256: "0".repeat(64) } }));

    expect(build(Buffer.from(JSON.stringify(packet)))).toMatchObject({ reason: "set-too-large" });
  });

  it("writes a fixer note naming the run, the layers, each file with its blob and each deletion", () => {
    const note = acceptSetNote(build() as BuiltSet, "run-1");

    expect(note).toContain("Shepherd run run-1: commit exactly the component and story baselines CI run 9001 regenerated");
    expect(note).toContain(`- write a/one.png (blob ${gitBlobId(AFTER_BYTES.k1!)})`);
    expect(note).toContain("- delete c/gone.png");
  });
});
