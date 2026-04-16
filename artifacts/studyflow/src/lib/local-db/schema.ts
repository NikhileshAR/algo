export type TelemetrySource = "auto" | "manual";

export interface TelemetryEvent {
  id: string;
  timestamp: string;
  url: string;
  title: string;
  topic: string | null;
  isStudy: boolean;
  focusedMs: number;
  idleMs: number;
  tabSwitches: number;
  interactionCount: number;
  videoWatchedMs: number;
  videoTotalMs: number;
  source: TelemetrySource;
  weight: number;
}

export interface TopicDaySummary {
  topic: string;
  focusedMinutes: number;
  distractionMinutes: number;
  focusRatio: number;
  interactionDensity: number;
  fragmentation: number;
  tabSwitchPenalty: number;
  videoEngagementRatio: number;
  qualityScore: number;
}

export interface TelemetryDaySummary {
  date: string;
  topics: TopicDaySummary[];
}

export interface SchedulerTelemetryInput {
  date: string;
  totalFocusedMinutes: number;
  totalDistractionMinutes: number;
  globalFocusRatio: number;
  topicQuality: Record<string, number>;
}
