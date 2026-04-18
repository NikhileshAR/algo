export type ObservabilityEvent =
  | "hydration_ready"
  | "hydration_failed"
  | "hydration_slow"
  | "loading_timeout"
  | "fallback_triggered"
  | "retry_requested"
  | "mission_fetch_failed";

export function logObservabilityEvent(event: ObservabilityEvent, payload?: Record<string, unknown>): void {
  const message = payload ? { event, ...payload } : { event };
  console.info("[studyflow-observe]", message);
}
