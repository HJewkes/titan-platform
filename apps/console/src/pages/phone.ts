import { useMediaQuery } from "./FramePins.js";

/** Tailwind's `md` breakpoint: below it a multi-column table squeezes its cells over each other. */
export const BELOW_MD = "(max-width: 767px)";

export const usePhone = (): boolean => useMediaQuery(BELOW_MD);

/** A phone tap needs a 44px target, more than a line of text or a dense tab gives it. */
export const PHONE_TAP = "inline-flex min-h-11 min-w-11 items-center";

/** The tap-target class on a phone and nothing on a desktop, which keeps its dense layout. */
export const usePhoneTap = (): string | undefined => (usePhone() ? PHONE_TAP : undefined);
