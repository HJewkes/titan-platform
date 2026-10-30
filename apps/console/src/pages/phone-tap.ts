/** A phone tap needs a 44px target, taller than a tab, chip or small button draws itself; a desktop keeps each control's own size. */
export const PHONE_TAP = "max-md:min-h-11 max-md:min-w-11";

/** The same for a link, which lays out inline and so ignores a min height until it is a flex box; a short id also needs the width. */
export const PHONE_TAP_LINK = "max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center";

/** For a press target drawn inside a react-ui part that takes no class for it, such as a brief's section steps or a table's sort header. */
export const PHONE_TAP_BUTTONS = "max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11";

/** The same for the anchors a table cell's external links render. */
export const PHONE_TAP_ANCHORS = "max-md:[&_a]:inline-flex max-md:[&_a]:min-h-11 max-md:[&_a]:min-w-11 max-md:[&_a]:items-center";
