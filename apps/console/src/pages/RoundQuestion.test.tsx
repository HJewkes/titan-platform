// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Question } from "../../server/round-schema.js";
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

const packet: Question = {
  ...pickOne,
  optionDetails: {
    "Screw lid": { detail: "Seals **airtight** in two turns.", weakPoint: "The thread clogs with sugar.", after: "Order screw lids for the next batch." },
    Cork: { detail: "Breathes, so the jam keeps longer." },
  },
};
const packetMany: Question = { ...pickMany, optionDetails: { Date: { detail: "When the jar was filled." } } };

/** A page that takes option notes, as the round pages do through `abAnswering`. */
function NotingHarness({ question, onNotes }: { question: Question; onNotes?: (notes: Record<string, string>) => void }): ReactNode {
  const [answer, setAnswer] = useState<QuestionAnswer>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const onNote = (option: string, text: string): void => {
    const next = { ...notes, [option]: text };
    setNotes(next);
    onNotes?.(next);
  };
  const choose = (choice: string): void => setAnswer((current) => chooseIn(question, current, choice));
  return <RoundQuestion question={question} position={1} answer={answer} onChoose={choose} active onActivate={() => undefined} ab={{ notes, onNote, onNeither: () => undefined }} />;
}

const card = (option: string): HTMLElement => screen.getByTestId(`option-card-${option}`);
const controlIn = (option: string): HTMLElement => {
  const found = card(option).querySelector<HTMLElement>('[role="radio"], [role="checkbox"]');
  if (!found) throw new Error(`no control in the ${option} card`);
  return found;
};

describe("a decision packet's option cards (G16)", () => {
  it("draws each option as a card with its detail, weak point and what picking it does", () => {
    render(<NotingHarness question={packet} />);

    expect(card("Screw lid").textContent).toContain("1  Screw lid");
    expect(within(card("Screw lid")).getByText("airtight")).toBeTruthy();
    expect(card("Screw lid").textContent).not.toContain("**");
    expect(card("Screw lid").textContent).toContain("WEAK POINT");
    expect(card("Screw lid").textContent).toContain("The thread clogs with sugar.");
    expect(card("Screw lid").textContent).toContain("IF YOU PICK THIS");
    expect(card("Screw lid").textContent).toContain("Order screw lids for the next batch.");
    expect(card("Cork").textContent).toContain("Breathes, so the jam keeps longer.");
    expect(card("Cork").textContent).not.toContain("WEAK POINT");
    expect(card("Clamp lid").textContent).toContain("3  Clamp lid");
  });

  it("picks the option when its card's control is pressed, and moves the pick between cards", () => {
    render(<NotingHarness question={packet} />);

    fireEvent.click(controlIn("Cork"));
    expect(controlIn("Cork").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(controlIn("Clamp lid"));
    expect(controlIn("Clamp lid").getAttribute("aria-checked")).toBe("true");
    expect(controlIn("Cork").getAttribute("aria-checked")).toBe("false");
  });

  it("toggles a pick-many option from its card", () => {
    render(<NotingHarness question={packetMany} />);

    fireEvent.click(controlIn("Contents"));
    fireEvent.click(controlIn("Date"));
    expect([controlIn("Date"), controlIn("Contents")].map((each) => each.getAttribute("aria-checked"))).toEqual(["true", "true"]);
  });

  it("gives every card its own note box, kept by option", () => {
    let notes: Record<string, string> = {};
    render(<NotingHarness question={packet} onNotes={(next) => (notes = next)} />);

    fireEvent.change(screen.getByLabelText("Note on Cork"), { target: { value: "Too loose for jam." } });
    fireEvent.change(screen.getByLabelText("Note on Clamp lid"), { target: { value: "Heavy." } });
    expect(notes).toEqual({ Cork: "Too loose for jam.", "Clamp lid": "Heavy." });
  });

  it("leaves a question with no option details as plain radios with no cards or note boxes", () => {
    render(<NotingHarness question={pickOne} />);

    expect(screen.queryByTestId("option-card-Cork")).toBeNull();
    expect(screen.queryByLabelText("Note on Cork")).toBeNull();
    expect(screen.getByText("2 Cork").closest('[role="radio"]')).toBeTruthy();
  });
});
