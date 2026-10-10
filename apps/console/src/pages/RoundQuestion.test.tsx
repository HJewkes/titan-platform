// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Question } from "@titan-design/review-schema";
import { RoundQuestion, chooseIn, choiceForKey, choicesOf, type QuestionAnswer } from "./RoundQuestion.js";

afterEach(cleanup);

const pickOne: Question = { id: "lid", kind: "pick-one", prompt: "Which lid fits the jar?", options: ["Screw lid", "Cork", "Clamp lid"], signsOff: "lid-part" };
const pickMany: Question = { id: "labels", kind: "pick-many", prompt: "Which labels go on the jar?", options: ["Date", "Contents"] };
const scale: Question = { id: "fill", kind: "scale", prompt: "How full is the jar?", min: 0, max: 3 };
const text: Question = { id: "notes", kind: "text", prompt: "Anything else?" };
const tenOptions: Question = { ...pickMany, options: Array.from({ length: 10 }, (_, index) => `Shelf ${index + 1}`) };

describe("a question's choices", () => {
  it("are its options, each step of its scale, or nothing for text", () => {
    expect(choicesOf(pickOne)).toEqual(["Screw lid", "Cork", "Clamp lid"]);
    expect(choicesOf(scale)).toEqual(["0", "1", "2", "3"]);
    expect(choicesOf(text)).toEqual([]);
  });

  it("map digits 1-9 to the first nine choices and nothing else", () => {
    expect(choiceForKey(pickOne, "3")).toBe("Clamp lid");
    expect(choiceForKey(pickOne, "4")).toBeNull();
    expect(choiceForKey(tenOptions, "9")).toBe("Shelf 9");
    expect(["0", "a", "10"].map((key) => choiceForKey(tenOptions, key))).toEqual([null, null, null]);
  });

  it("replace a single pick, set a scale value, and toggle a pick-many", () => {
    expect(chooseIn(pickOne, { pick: "Cork" }, "Screw lid")).toEqual({ pick: "Screw lid" });
    expect(chooseIn(scale, undefined, "2")).toEqual({ value: 2 });
    expect(chooseIn(pickMany, { picks: ["Date"] }, "Contents")).toEqual({ picks: ["Date", "Contents"] });
    expect(chooseIn(pickMany, { picks: ["Date", "Contents"] }, "Date")).toEqual({ picks: ["Contents"] });
  });
});

function Harness({ question }: { question: Question }): ReactNode {
  const [answer, setAnswer] = useState<QuestionAnswer>();
  const [active, setActive] = useState(false);
  return <RoundQuestion question={question} position={2} answer={answer} onChoose={(choice) => setAnswer((current) => chooseIn(question, current, choice))} active={active} onActivate={() => setActive(true)} />;
}

describe("RoundQuestion", () => {
  it("numbers the question and labels each option with its key", () => {
    render(<Harness question={pickOne} />);
    expect(screen.getByText("Q2")).toBeTruthy();
    expect(screen.getByText("2 Cork")).toBeTruthy();
    expect(screen.getByText("Signs off: lid-part")).toBeTruthy();
  });

  it("marks the pressed option chosen and activates the question", () => {
    render(<Harness question={pickOne} />);
    fireEvent.click(screen.getByText("2 Cork"));
    expect(screen.getByText("2 Cork").closest('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("keys 1-9 answer")).toBeTruthy();
  });

  it("leaves a choice past the ninth without a key", () => {
    render(<Harness question={tenOptions} />);
    expect(screen.getByText("Shelf 10")).toBeTruthy();
    expect(screen.getByText("9 Shelf 9")).toBeTruthy();
  });
});
