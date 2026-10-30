import { useMediaQuery } from "./FramePins.js";

/** Tailwind's `md` breakpoint as a media query: below it a page lays out for a phone. */
export const BELOW_MD = "(max-width: 767px)";

/** An `Input` draws 40px at its default size; a phone takes the large one for its 44px tap. */
export const usePhoneInputSize = (): "lg" | "md" => (useMediaQuery(BELOW_MD) ? "lg" : "md");

/** A phone tap needs a 44px target, taller than a tab, radio or button draws itself; a desktop keeps each control's own size. */
export const PHONE_TAP = "max-md:min-h-11";

/** The same for a link, which lays out inline and so ignores a min height until it is a flex box. */
export const PHONE_TAP_LINK = "max-md:inline-flex max-md:min-h-11 max-md:items-center";

/** A link whose text can be a few characters, a task id say, also needs 44px of width to hit. */
export const PHONE_TAP_ID_LINK = `${PHONE_TAP_LINK} max-md:min-w-11`;
