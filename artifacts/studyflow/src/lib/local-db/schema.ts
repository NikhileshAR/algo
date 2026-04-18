export type TelemetrySource = "auto" | "manual";
// Manual logs are downweighted so passive/auto telemetry remains the primary behavioral signal.
export const MANUAL_EVENT_WEIGHT = 0.5;

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

export type ValidationMode = "adaptive" | "baseline";

export interface DailyOutcomeSnapshot {
  date: string;
  planned_hours: number;
  actual_hours: number;
  completion_rate: number;
  sessions_completed: number;
  sessions_started: number;
  interruptions: number;
  reset_triggered: boolean;
  momentum_state: "none" | "building" | "strong" | "broken" | "recovering";
  discipline_score: number;
  capacity_estimate: number;
}

export interface DailyOutcomeSnapshotRecord extends DailyOutcomeSnapshot {
  id: string;
  mode: ValidationMode;
  timestamp: string;
}

export interface WeeklyValidationSummary {
  week_start: string;
  week_end: string;
  total_study_hours: number;
  average_completion_rate: number;
  consistency: number;
  average_session_completion_pct: number;
  resets_triggered: number;
  recovery_after_reset_days: number | null;
  completion_rate_metric: number;
  effective_study_hours: number;
  recovery_after_failure_days: number | null;
  high_priority_progress: number | null;
  capacity_trend: "upward" | "flat" | "declining";
}

export interface WeeklyValidationSummaryRecord extends WeeklyValidationSummary {
  id: string;
  mode: ValidationMode;
  timestamp: string;
}

export interface ResetImpactRecord {
  id: string;
  mode: ValidationMode;
  reset_date: string;
  before_completion_rate: number;
  after_completion_rate: number;
  completion_rate_change: number;
  before_hours: number;
  after_hours: number;
  hours_change: number;
  timestamp: string;
}

export interface DropoffEventRecord {
  id: string;
  mode: ValidationMode;
  inactivity_days: number;
  last_date: string;
  last_known_state: "active" | "paused";
  backlog_level: number;
  momentum_state: "none" | "building" | "strong" | "broken" | "recovering";
  timestamp: string;
}

export interface ValidationExecutionEvent {
  id: string;
  mode: ValidationMode;
  date: string;
  type: "started" | "interrupted";
  timestamp: string;
}
