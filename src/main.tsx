import React from "react";
import ReactDOM from "react-dom/client";
import DashboardRoot from "./DashboardRoot";
import "./styles.css";
import "./agent-os.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DashboardRoot />
  </React.StrictMode>
);
