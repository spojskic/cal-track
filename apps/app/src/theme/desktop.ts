// Pure (no React Native imports): the measurements of the desktop (wide) layout, shared by the app shell and the page layouts so
// they line up. Phones (< WIDE_BREAKPOINT) never read these.

/** Width of the desktop sidebar. */
export const SIDEBAR_WIDTH = 248;

/** Height of the slim bar at the top of every desktop page (title on the left, status or actions on the right). */
export const PAGE_HEADER_HEIGHT = 44;

/** Height of the thin status bar at the bottom of the desktop window. */
export const STATUS_BAR_HEIGHT = 26;

/** Widest a desktop page's content grows. Beyond this the content is centred. */
export const DESKTOP_CONTENT_MAX_WIDTH = 1440;

/** Space between the content and the edges of the content area, and between panels. */
export const DESKTOP_CONTENT_PADDING = 20;
export const PANEL_GAP = 12;

/** Height of the title strip at the top of a panel. */
export const PANEL_HEADER_HEIGHT = 34;
