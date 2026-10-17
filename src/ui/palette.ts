// Any part of the app can open (or close) the ⌘K palette with this event; the Shell owns the palette.
// A terminal uses it, because the Shell's own key handler ignores keys typed inside a terminal (.xterm).
export const PALETTE_EVENT = "aos-palette";

export function togglePalette() {
  window.dispatchEvent(new Event(PALETTE_EVENT));
}
