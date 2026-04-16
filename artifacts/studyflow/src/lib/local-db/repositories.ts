import { getTelemetryEventsInRange, putTelemetryEvent } from "./idb";
import { MANUAL_EVENT_WEIGHT, type SchedulerTelemetryInput, type TelemetryDaySummary, type TelemetryEvent, type TopicDaySummary } from "./schema";

// A gap above 2 minutes is treated as a new focus segment for fragmentation scoring.
const FRAGMENTATION_THRESHOLD_MS = 2 * 60 * 1000;
const LOW_INTERACTION_PER_MINUTE = 0.2;
const HIGH_TAB_SWITCH_PENALTY = 0.6;
const HIGH_FRAGMENTATION = 0.5;
const LOW_INTERACTION_QUALITY_PENALTY = 0.8;
const HIGH_SWITCH_QUALITY_PENALTY = 0.85;
const HIGH_FRAGMENTATION_QUALITY_PENALTY = 0.85;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function toDayWindow(date: string): { startIso: string; endIso: string } {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function normalizeEvent(input: Omit<TelemetryEvent, "id"> & { id?: string }): TelemetryEvent {
  const autoWeight = Number.isFinite(input.weight) && input.weight > 0 ? input.weight : 1;
  return {
    id: input.id ?? `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: input.timestamp,
    url: input.url,
    title: input.title,
    topic: input.topic,
    isStudy: input.isStudy,
    focusedMs: Math.max(0, input.focusedMs),
    idleMs: Math.max(0, input.idleMs),
    tabSwitches: Math.max(0, input.tabSwitches),
    interactionCount: Math.max(0, input.interactionCount),
    videoWatchedMs: Math.max(0, input.videoWatchedMs),
    videoTotalMs: Math.max(0, input.videoTotalMs),
    source: input.source,
    weight: input.source === "manual" ? MANUAL_EVENT_WEIGHT : autoWeight,
  };
}

function summarizeTopic(topic: string, events: TelemetryEvent[]): TopicDaySummary {
  const focusedMinutes = events.reduce((sum, e) => sum + (e.focusedMs * e.weight) / 60000, 0);
  const distractionMinutes = events.reduce((sum, e) => sum + (e.idleMs * e.weight) / 60000, 0);
  const totalMinutes = focusedMinutes + distractionMinutes;
  const focusRatio = totalMinutes > 0 ? clamp(focusedMinutes / totalMinutes) : 0;

  const interactionCount = events.reduce((sum, e) => sum + e.interactionCount * e.weight, 0);
  const interactionPerMinute = focusedMinutes > 0 ? interactionCount / focusedMinutes : 0;
  const interactionDensity = clamp(interactionPerMinute / 3);

  const sorted = [...events]
    .map((e) => ({ event: e, ts: Date.parse(e.timestamp) }))
    .filter((x) => Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);

  let segments = 0;
  let prevTs: number | null = null;
  for (const { ts } of sorted) {
    if (prevTs === null || ts - prevTs > FRAGMENTATION_THRESHOLD_MS) {
      segments += 1;
    }
    prevTs = ts;
  }
  const fragmentation = segments > 0 ? clamp((segments - 1) / segments) : 0;

  const switchRate = events.length > 0 ? events.reduce((sum, e) => sum + e.tabSwitches, 0) / events.length : 0;
  const tabSwitchPenalty = clamp(switchRate / 5);

  const watchedMs = events.reduce((sum, e) => sum + e.videoWatchedMs, 0);
  const totalMs = events.reduce((sum, e) => sum + e.videoTotalMs, 0);
  const videoEngagementRatio = totalMs > 0 ? clamp(watchedMs / totalMs) : 0;

  let qualityScore =
    focusRatio * 0.35 +
    interactionDensity * 0.25 +
    (1 - fragmentation) * 0.2 +
    (1 - tabSwitchPenalty) * 0.1 +
    videoEngagementRatio * 0.1;

  if (interactionPerMinute < LOW_INTERACTION_PER_MINUTE) {
    qualityScore *= LOW_INTERACTION_QUALITY_PENALTY;
  }
  if (tabSwitchPenalty > HIGH_TAB_SWITCH_PENALTY) {
    qualityScore *= HIGH_SWITCH_QUALITY_PENALTY;
  }
  if (fragmentation > HIGH_FRAGMENTATION) {
    qualityScore *= HIGH_FRAGMENTATION_QUALITY_PENALTY;
  }

  return {
    topic,
    focusedMinutes: Math.round(focusedMinutes * 100) / 100,
    distractionMinutes: Math.round(distractionMinutes * 100) / 100,
    focusRatio: Math.round(clamp(focusRatio) * 1000) / 1000,
    interactionDensity: Math.round(clamp(interactionDensity) * 1000) / 1000,
    fragmentation: Math.round(clamp(fragmentation) * 1000) / 1000,
    tabSwitchPenalty: Math.round(clamp(tabSwitchPenalty) * 1000) / 1000,
    videoEngagementRatio: Math.round(clamp(videoEngagementRatio) * 1000) / 1000,
    qualityScore: Math.round(clamp(qualityScore) * 1000) / 1000,
  };
}

export class TelemetryRepo {
  async addEvent(event: Omit<TelemetryEvent, "id"> & { id?: string }): Promise<void> {
    const normalized = normalizeEvent(event);
    if (normalized.focusedMs <= 0 && normalized.idleMs <= 0) {
      return;
    }
    await putTelemetryEvent(normalized);
  }

  async summarizeDay(date: string): Promise<TelemetryDaySummary> {
    const { startIso, endIso } = toDayWindow(date);
    const allEvents = await getTelemetryEventsInRange(startIso, endIso);

    const relevant = allEvents.filter((event) => event.focusedMs > 0 || event.idleMs > 0);

    const byTopic = new Map<string, TelemetryEvent[]>();
    for (const event of relevant) {
      const topic = event.topic ?? "Unclassified";
      const existing = byTopic.get(topic) ?? [];
      existing.push(event);
      byTopic.set(topic, existing);
    }

    const topics = Array.from(byTopic.entries())
      .map(([topic, events]) => summarizeTopic(topic, events))
      .sort((a, b) => b.focusedMinutes - a.focusedMinutes);

    return { date, topics };
  }

  async schedulerInput(date: string): Promise<SchedulerTelemetryInput> {
    const summary = await this.summarizeDay(date);
    const totalFocusedMinutes = summary.topics.reduce((sum, t) => sum + t.focusedMinutes, 0);
    const totalDistractionMinutes = summary.topics.reduce((sum, t) => sum + t.distractionMinutes, 0);
    const denominator = totalFocusedMinutes + totalDistractionMinutes;

    return {
      date,
      totalFocusedMinutes: Math.round(totalFocusedMinutes * 100) / 100,
      totalDistractionMinutes: Math.round(totalDistractionMinutes * 100) / 100,
      globalFocusRatio: denominator > 0 ? Math.round((totalFocusedMinutes / denominator) * 1000) / 1000 : 0,
      topicQuality: Object.fromEntries(summary.topics.map((topic) => [topic.topic, topic.qualityScore])),
    };
  }
}

let telemetryRepoSingleton: TelemetryRepo | null = null;

export function getTelemetryRepo(): TelemetryRepo {
  if (!telemetryRepoSingleton) {
    telemetryRepoSingleton = new TelemetryRepo();
  }
  return telemetryRepoSingleton;
}
