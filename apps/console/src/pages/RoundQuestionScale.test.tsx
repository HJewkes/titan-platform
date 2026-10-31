// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { unmountPages } from "../render-page.test-helpers.js";
import type { Question } from "../../server/round-schema.js";
import { RoundQuestion } from "./RoundQuestion.js";

afterEach(async () => {
  await unmountPages();
  vi.unstubAllGlobals();
});

const scale: Question = { id: "fill", kind: "scale", prompt: "How full is the jar?", min: 1, max: 5 };

const scaleText = (): string => {
  render(<RoundQuestion question={scale} position={1} answer={undefined} onChoose={() => undefined} active onActivate={() => undefined} />);
  return screen.getByRole("radiogroup").textContent.replace(/\s+/g, "");
};

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 767px)", media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

describe("a 1-to-5 scale question", () => {
  it("shows each digit once on a phone", () => {
    onPhone();
    expect(scaleText()).toBe("1to512345");
  });

  it("keeps the key hint beside each digit on a desktop", () => {
    expect(scaleText()).toBe("1to51122334455");
  });
});
