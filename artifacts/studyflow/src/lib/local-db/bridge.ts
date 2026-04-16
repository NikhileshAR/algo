import { getTelemetryRepo } from "./repositories";
import { MANUAL_EVENT_WEIGHT, type SchedulerTelemetryInput, type TelemetryEvent } from "./schema";

function normalizeIncomingEvent(raw: Record<string, unknown>): Omit<TelemetryEvent, "id"> {
  return {
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    url: typeof raw.url === "string" ? raw.url : window.location.href,
    title: typeof raw.title === "string" ? raw.title : document.title,
    topic: typeof raw.topic === "string" ? raw.topic : null,
    isStudy: typeof raw.isStudy === "boolean" ? raw.isStudy : false,
    focusedMs: typeof raw.focusedMs === "number" ? raw.focusedMs : 0,
    idleMs: typeof raw.idleMs === "number" ? raw.idleMs : 0,
    tabSwitches: typeof raw.tabSwitches === "number" ? raw.tabSwitches : 0,
    interactionCount: typeof raw.interactionCount === "number" ? raw.interactionCount : 0,
    videoWatchedMs: typeof raw.videoWatchedMs === "number" ? raw.videoWatchedMs : 0,
    videoTotalMs: typeof raw.videoTotalMs === "number" ? raw.videoTotalMs : 0,
    source: typeof raw.source === "string" && raw.source === "manual" ? "manual" : "auto",
    weight: typeof raw.weight === "number" ? raw.weight : 1,
  };
}

export function startTelemetryBridge(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || typeof event.data !== "object" || event.data === null) {
      return;
    }

    const payload = event.data as Record<string, unknown>;
    const type = payload.type;
    if (type !== "STUDYFLOW_TELEMETRY_EVENT") {
      return;
    }

    const repo = getTelemetryRepo();
    void repo.addEvent(normalizeIncomingEvent(payload));
  });
}

export async function getSchedulerTelemetryInput(date: string): Promise<SchedulerTelemetryInput> {
  const repo = getTelemetryRepo();
  return repo.schedulerInput(date);
}

export async function syncSchedulerTelemetryInput(date: string): Promise<void> {
  const input = await getSchedulerTelemetryInput(date);
  localStorage.setItem("studyflow.scheduler.telemetry", JSON.stringify(input));
}

export async function recordManualTelemetryEvent(event: {
  topic: string;
  durationMinutes: number;
  title?: string;
}): Promise<void> {
  const repo = getTelemetryRepo();
  const focusedMs = Math.max(0, Math.round(event.durationMinutes * 60 * 1000));
  await repo.addEvent({
    timestamp: new Date().toISOString(),
    url: "manual://session",
    title: event.title ?? `Manual session: ${event.topic}`,
    topic: event.topic,
    isStudy: true,
    focusedMs,
    idleMs: 0,
    tabSwitches: 0,
    interactionCount: 0,
    videoWatchedMs: 0,
    videoTotalMs: 0,
    source: "manual",
    weight: MANUAL_EVENT_WEIGHT,
  });
}
