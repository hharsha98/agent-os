export function queryParam(name: string) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

export function navigateTo(page: string, extra: Record<string, string> = {}) {
  const next = new URL(window.location.href);
  next.searchParams.set("page", page);
  // `step` picks a Setup step (check, plan, install, brain, signin, ready) and
  // `example` asks the Runs page to open the New run dialog with the safe example typed in.
  // `session` picks a Sessions tab, `tab` a page's own tab (Runs: "recordings") and `highlight` the row
  // to mark there ("Open recording" lands on its session's row).
  for (const key of ["file", "folder", "filter", "agent", "run", "room", "step", "example", "session", "tab", "highlight"]) {
    if (extra[key]) next.searchParams.set(key, extra[key]);
    else next.searchParams.delete(key);
  }
  window.history.replaceState({}, "", next);
  window.dispatchEvent(new Event("aos-navigate"));
}
