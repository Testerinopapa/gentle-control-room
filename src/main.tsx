import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Gentle Control Room tracking test: this harmless change should appear in local Git diffs.
createRoot(document.getElementById("root")!).render(<App />);
