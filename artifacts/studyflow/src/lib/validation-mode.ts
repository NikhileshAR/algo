import { useEffect, useState } from "react";
import type { ValidationMode } from "@/lib/local-db/schema";

const MODE_KEY = "studyflow.validation.mode";
const MODE_EVENT = "studyflow.validation.mode.changed";

function isMode(value: unknown): value is ValidationMode {
  return value === "adaptive" || value === "baseline";
}

export function getValidationMode(): ValidationMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return isMode(raw) ? raw : "adaptive";
  } catch {
    return "adaptive";
  }
}

export function setValidationMode(mode: ValidationMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore storage errors
  }
  window.dispatchEvent(new CustomEvent<ValidationMode>(MODE_EVENT, { detail: mode }));
}

export function useValidationMode(): [ValidationMode, (mode: ValidationMode) => void] {
  const [mode, setMode] = useState<ValidationMode>(() => getValidationMode());

  useEffect(() => {
    const onStorage = () => setMode(getValidationMode());
    const onMode = (event: Event) => {
      const detail = (event as CustomEvent<ValidationMode>).detail;
      if (isMode(detail)) {
        setMode(detail);
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(MODE_EVENT, onMode);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(MODE_EVENT, onMode);
    };
  }, []);

  return [mode, setValidationMode];
}

export function scheduleEndpointForMode(mode: ValidationMode): string {
  return `/api/schedule/today?mode=${encodeURIComponent(mode)}`;
}
