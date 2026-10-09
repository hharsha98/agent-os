export function queryParam(name: string) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

export function navigateTo(page: string, extra: Record<string, string> = {}) {
  const next = new URL(window.location.href);
  next.searchParams.set("page", page);
  // `step` picks a Setup step (check, plan, install, brain, signin, ready) and
  // `example` asks the Agents launch panel to start with the safe example prompt.
  for (const key of ["file", "folder", "filter", "agent", "run", "room", "step", "example"]) {
    if (extra[key]) next.searchParams.set(key, extra[key]);
    else next.searchParams.delete(key);
  }
  window.history.replaceState({}, "", next);
  window.dispatchEvent(new Event("aos-navigate"));
}
