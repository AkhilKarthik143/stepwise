import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { Landing } from "./Landing";
import "./index.css";

// The field surface is the product front door. Keep the inherited marketing page available at
// #landing for attribution/reuse, while the AR console owns the root URL used by technicians.
function isLanding() {
  return window.location.hash.replace(/^#\/?/, "") === "landing";
}

function Root() {
  const [landingView, setLandingView] = useState(isLanding);
  useEffect(() => {
    const onHash = () => setLandingView(isLanding());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return landingView ? <Landing /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
