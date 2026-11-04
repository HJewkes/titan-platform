import { describe, expect, it } from "vitest";
import { buildSidecar, classify, type SidecarInput } from "./video-sidecar.js";
import { ConsoleSidecarSchema } from "./video-meta-mirror.test-helpers.js";
import { tour } from "./voice-flow-fixtures.test-helpers.js";

const explainer = { videoId: "run-a", runIds: ["run-a", "run-b"], profile: "repo-tour", scriptSha: "0123abcd", fingerprint: { beats: [] } };

function input(overrides: Partial<SidecarInput> = {}): SidecarInput {
  return { script: tour(), profile: "repo-tour", durationS: 200, stem: "parcel-desk", take: "v1", status: "review", explainer, ...overrides };
}

describe("buildSidecar", () => {
  it("writes a repo-tour video as a repo review, its promise as the description and its poster 30 % in", () => {
    const sidecar = buildSidecar(input());

    expect(sidecar).toMatchObject({
      schema: "titan-console/video-meta@1",
      title: "parcel-desk-v1 review explainer",
      description: "You can tell which scans the desk trusts",
      purpose: "repo-review",
      series: "repo-review-explainers",
      subject: { kind: "repo", id: "parcel-desk-v1" },
      take: "v1",
      status: "review",
      posterAtS: 60,
      poster: "parcel-desk-poster.jpg",
      explainer,
    });
  });

  it("rounds the poster time to a tenth of a second", () => {
    const sidecar = buildSidecar(input({ durationS: 123.45 }));

    expect(sidecar.posterAtS).toBe(37);
  });

  it("parses under the theater's sidecar schema, explainer block included", () => {
    const sidecar = buildSidecar(input());

    const parsed = ConsoleSidecarSchema.safeParse(JSON.parse(JSON.stringify(sidecar)));

    expect(parsed.success, parsed.error?.message).toBe(true);
  });
});

describe("classify", () => {
  it.each([
    ["repo-tour", "repo-review"],
    ["repo-argument", "repo-review"],
    ["daily-overview", "daily"],
    ["paper-summary", "explainer"],
  ])("reads profile %s as purpose %s before any id heuristic", (profile, purpose) => {
    const classified = classify({ id: "parcel-desk-2026-01-05", profile: "status-x" }, profile);

    expect(classified.purpose).toBe(purpose);
  });

  it("names a daily by its id less the date, with the day as its subject", () => {
    const classified = classify({ id: "parcel-digest-2026-01-05", profile: "daily-overview" }, "daily-overview");

    expect(classified).toEqual({ title: "parcel digest 2026-01-05", purpose: "daily", series: "parcel-digest", subject: { kind: "day", id: "2026-01-05" } });
  });

  it("keeps the repo slug of a review id as the subject and the title's repo", () => {
    const classified = classify({ id: "parcel-desk-review-explainer", profile: "pr-overview" }, "pr-overview");

    expect(classified).toMatchObject({ title: "parcel-desk review explainer", subject: { kind: "repo", id: "parcel-desk" } });
  });

  it("files a design profile's video as design", () => {
    const classified = classify({ id: "parcel-desk", profile: "x" }, "system-design");

    expect(classified).toEqual({ title: "parcel desk", purpose: "design", series: "parcel-desk" });
  });
});
