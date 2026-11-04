import { describe, expect, it } from "vitest";
import { alarmKey } from "./keys.js";
import { collapseRepeats } from "./repeats.js";
import { item } from "./test-fixtures.js";

const alarm = (id: string, openedAt: string, asker = "titan-console") => item({ id, asker, openedAt, keys: ["console-update", alarmKey("console-update")] });

describe("collapseRepeats", () => {
  it("keeps only the newest open alarm from one source, with the count of every repeat", () => {
    const items = [alarm("a", "2031-03-01T00:00:00Z"), alarm("c", "2031-03-03T00:00:00Z"), alarm("b", "2031-03-02T00:00:00Z")];

    expect(collapseRepeats(items)).toEqual([{ ...items[1], repeats: 3 }]);
  });

  it("keeps apart the same alarm key from two askers, and passes through items with no alarm key", () => {
    const plain = item({ id: "plain", keys: ["console-update"] });
    const items = [alarm("a", "2031-03-01T00:00:00Z"), plain, alarm("b", "2031-03-02T00:00:00Z", "seat-x")];

    expect(collapseRepeats(items)).toEqual(items);
  });
});

describe("alarmKey", () => {
  it("names the source after alarm:, and refuses a blank one", () => {
    expect(alarmKey(" deploy-alarm:titan-factory ")).toBe("alarm:deploy-alarm:titan-factory");
    expect(() => alarmKey(" ")).toThrow("alarm key needs a source");
  });
});
