import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// An open tab can outlive a Vercel deployment. When that tab later opens a
// lazy-loaded route, its old entry bundle may request a chunk that no longer
// exists at the production alias. Vite emits this event before surfacing the
// failed dynamic import, so refresh once to load the current app manifest.
// Keep a short session guard to avoid a reload loop during a genuine outage.
const PRELOAD_RECOVERY_KEY = "bioalyzer:preload-recovery";
const PRELOAD_RECOVERY_COOLDOWN_MS = 10_000;

window.addEventListener("vite:preloadError", (event) => {
  const lastRecovery = Number(
    window.sessionStorage.getItem(PRELOAD_RECOVERY_KEY) ?? "0",
  );

  if (Date.now() - lastRecovery < PRELOAD_RECOVERY_COOLDOWN_MS) return;

  event.preventDefault();
  window.sessionStorage.setItem(PRELOAD_RECOVERY_KEY, String(Date.now()));
  window.location.reload();
});

window.setTimeout(() => {
  window.sessionStorage.removeItem(PRELOAD_RECOVERY_KEY);
}, PRELOAD_RECOVERY_COOLDOWN_MS);

createRoot(document.getElementById("root")!).render(<App />);
