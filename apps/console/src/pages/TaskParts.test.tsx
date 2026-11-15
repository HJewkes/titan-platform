// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { stageLabel, TaskStageBadge } from "./TaskParts.js";

afterEach(cleanup);

const unknownStage = "triaged";

describe("an unknown task stage", () => {
  it("renders its raw text as a pill instead of throwing", () => {
    render(<TaskStageBadge stage={unknownStage} />);

    expect(screen.getByText("triaged")).toBeTruthy();
  });

  it("labels itself with the raw stage text", () => {
    expect(stageLabel(unknownStage)).toBe("triaged");
  });

  it("keeps the known label for a known stage", () => {
    expect(stageLabel("review")).toBe("In review");
  });
});
