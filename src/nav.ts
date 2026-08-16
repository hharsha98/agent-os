export function queryParam(name: string) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

export function navigateTo(page: string, extra: Record<string, string> = {}) {
  const next = new URL(window.location.href);
  next.searchParams.set("page", page);
  for (const key of ["file", "folder"]) {
    if (extra[key]) next.searchParams.set(key, extra[key]);
    else next.searchParams.delete(key);
  }
  window.history.replaceState({}, "", next);
  window.dispatchEvent(new Event("aos-navigate"));
}
