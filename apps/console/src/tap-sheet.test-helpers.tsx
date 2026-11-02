import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";

/**
 * The open confirm sheet once its prepare has answered. A TapSheet mounts reading and renders the read-back only after the
 * prepare resolves, so a sync query on the bare sheet races that answer (TP-4634); every sheet test opens through here.
 */
export async function findTapSheet(testID: string): Promise<HTMLElement> {
  const sheet = await screen.findByTestId(testID);
  await waitFor(() => expect(within(sheet).queryByTestId(`${testID}-reading`)).toBeNull());
  return sheet;
}

/** The open confirm sheet while its prepare is still held, for a test that asserts what the sheet does before the read-back. */
export async function findReadingTapSheet(testID: string): Promise<HTMLElement> {
  const sheet = await screen.findByTestId(testID);
  expect(within(sheet).getByTestId(`${testID}-reading`)).toBeTruthy();
  return sheet;
}
