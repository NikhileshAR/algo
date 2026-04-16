/**
 * Scheduler Web Worker — Phase 1
 *
 * Runs the pure computeSchedule() algorithm off the main thread so that
 * heavy scheduling computation (especially with large topic sets) doesn't
 * block the UI.
 *
 * Message protocol:
 *
 *   Request:
 *     { type: "COMPUTE_SCHEDULE", id: string, payload: SchedulerInput }
 *
 *   Response (success):
 *     { type: "SCHEDULE_RESULT", id: string, payload: SchedulerResult }
 *
 *   Response (error):
 *     { type: "SCHEDULE_ERROR", id: string, error: string }
 *
 * The caller matches responses to requests via the `id` field.
 *
 * Usage from React:
 *
 *   const worker = new Worker(
 *     new URL('../workers/scheduler.worker.ts', import.meta.url),
 *     { type: 'module' }
 *   );
 */

import { computeSchedule } from "../lib/local-db/scheduler-algo";
import type { SchedulerInput, SchedulerResult } from "../lib/local-db/schema";

// ─── Message types ────────────────────────────────────────────────────────────

interface ComputeScheduleMessage {
  type: "COMPUTE_SCHEDULE";
  id: string;
  payload: SchedulerInput;
}

interface ScheduleResultMessage {
  type: "SCHEDULE_RESULT";
  id: string;
  payload: SchedulerResult;
}

interface ScheduleErrorMessage {
  type: "SCHEDULE_ERROR";
  id: string;
  error: string;
}

export type WorkerInMessage = ComputeScheduleMessage;
export type WorkerOutMessage = ScheduleResultMessage | ScheduleErrorMessage;

// ─── Worker entry point ───────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === "COMPUTE_SCHEDULE") {
    try {
      const result: SchedulerResult = computeSchedule(msg.payload);
      const response: ScheduleResultMessage = {
        type: "SCHEDULE_RESULT",
        id: msg.id,
        payload: result,
      };
      self.postMessage(response);
    } catch (err) {
      const response: ScheduleErrorMessage = {
        type: "SCHEDULE_ERROR",
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
  }
};
