// What to call this computer in a sentence (final review, Se M4): "this Mac" on a Mac, "this PC" on Windows and "this computer" on
// anything else, the same choice the menu footer makes (MACHINE_LABEL in Shell.tsx). A Windows or Linux build used to say "Codex isn't
// installed on this Mac." Pure and with no imports, so test/safety-shared.test.js loads it straight from src/.
export function thisMachine(platform: string | null | undefined): string {
  const name = platform || "";
  return /mac/i.test(name) ? "this Mac" : /win/i.test(name) ? "this PC" : "this computer";
}

const PLATFORM = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";

// This computer's words, chosen once when the page loads.
export const THIS_MACHINE = thisMachine(PLATFORM);

// What to call the program that shows a file in its folder (re-review N4): Finder on a Mac, File Explorer on Windows and "the
// file manager" on anything else. `show` labels the button, `failed` starts the notice when it could not be opened.
export function fileManagerWords(platform: string | null | undefined): { show: string; failed: string } {
  const name = platform || "";
  if (/mac/i.test(name)) return { show: "Show in Finder", failed: "Finder could not be opened." };
  if (/win/i.test(name)) return { show: "Show in File Explorer", failed: "File Explorer could not be opened." };
  return { show: "Show in file manager", failed: "The file manager could not be opened." };
}

export const FILE_MANAGER = fileManagerWords(PLATFORM);
