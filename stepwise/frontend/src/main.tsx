import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ConsoleApp from "./ConsoleApp";
import { Dashboard } from "./Dashboard";
import { Landing } from "./Landing";
import "./index.css";

// BuildSight owns the root URL (the phone). #dashboard is the second screen at the demo table;
// #console and #landing keep the inherited CNC console and marketing page for reference.
function route() {
  return window.location.hash.replace(/^#\/?/, "");
}

function Root() {
  const [view, setView] = useState(route);
  useEffect(() => {
    const onHash = () => setView(route());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (view === "dashboard") return <Dashboard />;
  if (view === "console") return <ConsoleApp />;
  if (view === "landing") return <Landing />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
