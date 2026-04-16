import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { startTelemetryBridge } from "@/lib/local-db/bridge";

startTelemetryBridge();

createRoot(document.getElementById("root")!).render(<App />);
