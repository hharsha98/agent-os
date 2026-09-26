import React from "react";
import ReactDOM from "react-dom/client";
import DashboardRoot from "./DashboardRoot";
import "./styles.css";
import "./agent-os.css";

// a "launch" query param carries the one-time local session
// token printed in the terminal. Claim it, strip it from the URL (so it
// never lingers in history or gets sent as a Referer), then render.
async function claimLaunchToken() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("launch");
  if (!token) return;
  try {
    await fetch("/api/session/claim", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
  } catch {
    // Network error: the LockedScreen still shows if the session stayed locked.
  } finally {
    params.delete("launch");
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }
}

// No top-level await: the configured build target (older browsers) doesn't
// support it, so chain the render instead.
void claimLaunchToken().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <DashboardRoot />
    </React.StrictMode>
  );
});
