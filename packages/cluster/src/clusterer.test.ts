import { describe, expect, it } from "vitest";
import { Clusterer } from "./clusterer.js";
import { DrainTreeRegistry } from "./registry.js";
import { templateId } from "./template-id.js";

const bash = (text: string) => ({ partition: "Bash", text });

describe("Clusterer", () => {
  it("mints a template on first sight and reuses it for structurally identical blobs", () => {
    const clusterer = new Clusterer();
    const first = clusterer.cluster(bash("TypeError: Cannot find module src/a.ts"));
    const second = clusterer.cluster(bash("TypeError: Cannot find module src/b.ts"));
    expect(first.isNewTemplate).toBe(true);
    expect(second.isNewTemplate).toBe(false);
    expect(second.templateId).toBe(first.templateId);
    expect(second.maskedSignature).toBe(first.maskedSignature);
    expect(second.maskedSignature).toContain("Cannot find module <PATH>");
    expect(second.extractedParams.PATH).toBe("src/b.ts");
    expect(clusterer.templateCount).toBe(1);
  });

  it("keeps partitions apart even for identical text", () => {
    const clusterer = new Clusterer();
    const a = clusterer.cluster({ partition: "Bash", text: "TypeError: boom" });
    const b = clusterer.cluster({ partition: "Read", text: "TypeError: boom" });
    expect(a.templateId).not.toBe(b.templateId);
    expect(a.templateId).toBe(templateId("Bash", a.maskedSignature));
  });

  it("produces identical template ids across independent runs over the same corpus", () => {
    const corpus = [
      bash("TypeError: Cannot find module a.ts"),
      bash("FAIL suite timeout after 30000 ms"),
      bash("TypeError: Cannot find module b.ts"),
    ];
    const run = () => {
      const c = new Clusterer();
      return corpus.map((b) => c.cluster(b).templateId);
    };
    expect(run()).toEqual(run());
  });

  it("restores from a snapshot with bindings and learned wildcards intact", () => {
    const first = new Clusterer({ drain: { simTh: 0.5 } });
    const original = first.cluster(bash("error TS1234: Cannot find module a.ts"));
    first.cluster(bash("error TS1234: Cannot find module b.ts"));

    const restored = Clusterer.fromSnapshot(JSON.parse(JSON.stringify(first.snapshot())), { drain: { simTh: 0.5 } });
    const again = restored.cluster(bash("error TS1234: Cannot find module c.ts"));
    expect(again.templateId).toBe(original.templateId);
    expect(again.isNewTemplate).toBe(false);
    expect(restored.templateCount).toBe(1);
    expect(restored.snapshot().partitions[0]!.templateIds).toEqual([[1, original.templateId]]);
  });

  it("reports eviction once a partition hits its cluster cap", () => {
    const clusterer = new Clusterer({ drain: { maxClusters: 2, simTh: 0.99 } });
    expect(clusterer.evicting).toBe(false);
    for (const shape of ["one", "two", "three"]) clusterer.cluster(bash(`Error${shape}: x`));
    expect(clusterer.evicting).toBe(true);
  });
});

describe("DrainTreeRegistry", () => {
  it("keeps one isolated tree per partition and snapshots them all", () => {
    const registry = new DrainTreeRegistry();
    expect(registry.getTree("Bash")).toBe(registry.getTree("Bash"));
    registry.getTree("Bash").insert(["error", "a"]);
    registry.getTree("Read").insert(["error", "a"]);
    expect(registry.getTree("Bash").clusterCount).toBe(1);
    expect(registry.partitions.sort()).toEqual(["Bash", "Read"]);
    expect(Object.keys(registry.snapshot()).sort()).toEqual(["Bash", "Read"]);
  });
});
