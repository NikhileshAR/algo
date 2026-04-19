export type ObservabilityEvent =
  | "hydration_ready"
  | "hydration_failed"
  | "hydration_slow"
  | "loading_timeout"
  | "fallback_triggered"
  | "fallback_reconciled"
  | "retry_requested"
  | "mission_fetch_failed"
  | "execution_block_locked"
  | "execution_block_mismatch"
  | "execution_block_out_of_bounds"
  | "execution_schedule_lost"
  | "cross_tab_sync_received";

export function logObservabilityEvent(event: ObservabilityEvent, payload?: Record<string, unknown>): void {
  const message = payload ? { event, ...payload } : { event };
  console.info("[studyflow-observe]", message);
}
