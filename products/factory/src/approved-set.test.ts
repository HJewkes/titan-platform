import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_SET_FILES, acceptSetNote, approvedSetOf, gitBlobId, setMatch } from "./approved-set.js";
import { AFTER_BYTES, COMPONENT, STORY, acceptImages, acceptPacket, afterDigests, setImage } from "./test-support/accept-set.js";

const H = "a".repeat(40);
const where = { repo: "example-org/example-repo", pr: 7, headSha: H, headTree: "c".repeat(40) };
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function build(packet = acceptPacket(where), after = afterDigests()) {
  return approvedSetOf({ packet, packetSha: sha256(packet), fromHead: H, after });
}

function built() {
  const result = build();
  if ("reason" in result) throw new Error(result.detail);
  return result;
}

/** The fixture's images with the first one (`k2`, a new story image) given `path`. */
const withPath = (path: string) => build(acceptPacket(where, [{ ...acceptImages()[0]!, path }, ...acceptImages().slice(1)]));

describe("approvedSetOf", () => {
  it("lists changed and new images by path with their after sha256 and blob id, removed ones by path, and no side paths", () => {
    const files = [
      { path: `${COMPONENT}one.png`, key: "k1", sha256: sha256(AFTER_BYTES.k1!), blob: gitBlobId(AFTER_BYTES.k1!) },
      { path: `${STORY}two.png`, key: "k2", sha256: sha256(AFTER_BYTES.k2!), blob: gitBlobId(AFTER_BYTES.k2!) },
    ];
    const set = { packetSha: sha256(acceptPacket(where)), packetId: "p-accept", ciRunId: "9001", fromHead: H, files, removed: [`${COMPONENT}gone.png`], sidePaths: [] };

    expect(build()).toEqual({ layers: ["component", "story"], set });
    expect(gitBlobId(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("refuses an after image whose bytes do not hash to the packet's after.sha256", () => {
    const after = afterDigests();
    after.set("k2", { sha256: sha256(Buffer.from("other bytes")), blob: gitBlobId(Buffer.from("other bytes")) });

    expect(build(acceptPacket(where), after)).toMatchObject({ reason: "packet", detail: "after/k2.png does not hash to the packet's after.sha256" });
  });

  it(`refuses set-too-large past ${MAX_SET_FILES} kept images`, () => {
    const images = Array.from({ length: MAX_SET_FILES + 1 }, (_, n) => ({ key: `k${n}`, layer: "story", path: `${STORY}${n}.png`, change: "new", after: { sha256: "0".repeat(64) } }));

    expect(build(Buffer.from(JSON.stringify({ packetId: "p-big", headSha: H, ci: { runId: "1" }, images })))).toMatchObject({ reason: "set-too-large" });
  });

  it.each([
    ["climbs out of the repo", "../../.github/workflows/x.yml"],
    ["is absolute", "/etc/passwd"],
    ["holds a NUL", `${STORY}b\u0000.png`],
    ["is empty", ""],
    ["adds a line to the note", `${STORY}one.png (blob 0)\n- write src/evil.ts (blob deadbeef)`],
    ["has a .. segment under its prefix", `${STORY}../../../../../src/evil.png`],
    ["has an empty segment", `${STORY}/two.png`],
  ])("refuses packet when an image path %s", (_name, path) => {
    expect(withPath(path)).toEqual({ reason: "packet", detail: "image k2 has an unsafe path" });
  });

  it("refuses packet when an image path is outside its own layer's baselines", () => {
    expect(withPath(`${COMPONENT}two.png`)).toEqual({ reason: "packet", detail: "image k2's path is not under the story baselines" });
    expect(build(acceptPacket(where, [setImage("k2", "toString", `${STORY}two.png`, "new")]))).toMatchObject({ reason: "packet" });
  });

  it.each([
    ["one path under two keys", [setImage("k1", "story", `${STORY}two.png`, "changed"), setImage("k2", "story", `${STORY}two.png`, "new")]],
    ["one path changed and removed", [setImage("k2", "story", `${STORY}two.png`, "new"), setImage("k3", "story", `${STORY}two.png`, "removed")]],
    ["one key with two paths", [setImage("k2", "story", `${STORY}two.png`, "new"), setImage("k2", "story", `${STORY}three.png`, "new")]],
  ])("refuses packet for %s", (_name, images) => {
    expect(build(acceptPacket(where, images))).toMatchObject({ reason: "packet", detail: expect.stringContaining("repeats a path or key") });
  });
});

describe("acceptSetNote", () => {
  it("names the run, the layers, each file with its blob and each deletion", () => {
    const note = acceptSetNote(built(), "run-1", 4000);

    expect(note).toContain("Shepherd run run-1: commit exactly the component and story baselines CI run 9001 regenerated");
    expect(note).toContain(`- write ${COMPONENT}one.png (blob ${gitBlobId(AFTER_BYTES.k1!)})`);
    expect(note).toContain(`- delete ${COMPONENT}gone.png`);
  });

  it("passes a note exactly at the limit and refuses set-too-large one character over, so no file is cut from the list", () => {
    const full = acceptSetNote(built(), "run-1", Infinity);
    if (typeof full !== "string") throw new Error(full.detail);
    const length = [...full].length;

    expect(acceptSetNote(built(), "run-1", length)).toEqual(expect.any(String));
    expect(acceptSetNote(built(), "run-1", length - 1)).toEqual({ reason: "set-too-large", detail: `the fixer's note for this set is ${length} characters, over ${length - 1}` });
  });
});

describe("setMatch", () => {
  it("refuses a carry-fenced changed path before naming it an extra path", () => {
    const { set } = built();
    const atHead = new Map(set.files.map((file) => [file.path, file.blob]));

    expect(setMatch(set, { changed: [".github/workflows/ci.yml"], atHead })).toEqual({ carries: false, reason: "skill-or-fenced", paths: [".github/workflows/ci.yml"] });
    expect(setMatch(set, { changed: set.files.map((file) => file.path), atHead })).toEqual({ carries: true });
  });
});
