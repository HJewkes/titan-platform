import { useMediaQuery } from "./FramePins.js";

/** Tailwind's `md` breakpoint as a media query: below it a page lays out for a phone. */
export const BELOW_MD = "(max-width: 767px)";

/** An `Input` draws 40px at its default size; a phone takes the large one for its 44px tap. */
export const usePhoneInputSize = (): "lg" | "md" => (useMediaQuery(BELOW_MD) ? "lg" : "md");

/** A phone tap needs a 44px target, larger than a tab, radio, chip or button draws itself; a desktop keeps each control's own size. */
export const PHONE_TAP = "max-md:min-h-11 max-md:min-w-11";

/** The same for a link, which lays out inline and so ignores a min height until it is a flex box. */
export const PHONE_TAP_LINK = "max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center";

/** For a press target drawn inside a react-ui part that takes no class for it, such as a brief's section steps or a table's sort header. */
export const PHONE_TAP_BUTTONS = "max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11";

/** The same for the anchors a table cell's external links render. */
export const PHONE_TAP_ANCHORS = "max-md:[&_a]:inline-flex max-md:[&_a]:min-h-11 max-md:[&_a]:min-w-11 max-md:[&_a]:items-center";
