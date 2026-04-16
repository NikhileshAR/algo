/**
 * LOCAL-FIRST DATA SCHEMA — Phase 1
 *
 * All data lives in IndexedDB on the user's device.
 * The API server, if present, is a sync relay only — never the source of truth.
 *
 * IDs are string UUIDs generated locally via crypto.randomUUID().
 * Timestamps are ISO-8601 strings.
 */

// ─── Database constants ───────────────────────────────────────────────────────

export const DB_NAME = "studyflow";
export const DB_VERSION = 1;

export const STORE = {
  PROFILE: "profile",
  TOPICS: "topics",
  SESSIONS: "sessions",
  SCHEDULES: "schedules",
  TELEMETRY: "telemetry",
  OVERRIDES: "overrides",
  META: "meta",
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

// ─── Student profile ──────────────────────────────────────────────────────────

export interface LocalStudentProfile {
  id: string;
  name: string;
  examName: string;
  examDate: string; // YYYY-MM-DD
  dailyTargetHours: number;
  /** K: smoothed average of actual daily study hours */
  capacityScore: number;
  /** D: ratio of actual focused study time to scheduled study time (0–1) */
  disciplineScore: number;
  /** d: external interruption ratio — separate from discipline */
  distractionScore: number;
  /** A: proportion of sessions that are active practice (0–1) */
  activePracticeRatio: number;
  /** Total override recalculations triggered by the user (audit metric) */
  overrideCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Topics ───────────────────────────────────────────────────────────────────

export interface LocalTopic {
  id: string;
  name: string;
  subject: string;
  masteryScore: number; // 0–1
  confidenceScore: number; // 0–1, grows with practice attempts
  priorityScore: number; // computed, higher = more urgent
  difficultyLevel: number; // 1–5
  estimatedHours: number;
  prerequisites: string[]; // local topic IDs
  isCompleted: boolean;
  testsCount: number;
  lastStudiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Study sessions ───────────────────────────────────────────────────────────

export type SessionSource = "auto" | "manual" | "extension";

export interface LocalStudySession {
  id: string;
  topicId: string;
  topicName: string;
  sessionType: "lecture" | "practice";
  durationMinutes: number;
  distractionMinutes: number;
  /**
   * Source of this session record:
   * - "auto"      → browser extension passive tracking (weight 1.0)
   * - "extension" → extension manual start/stop (weight 1.0)
   * - "manual"    → user typed duration into web app (weight 0.5)
   */
  source: SessionSource;
  /**
   * Quality confidence weight applied to model updates.
   * auto/extension = 1.0, manual = 0.5
   */
  qualityWeight: number;
  /** Focus ratio: activeStudyTime / (activeStudyTime + distractionTime). 0–1 */
  focusRatio: number;
  /** Composite quality index (focus × interaction × completeness). 0–1 */
  qualityScore: number;
  testScore: number | null;
  testScoreMax: number | null;
  notes: string | null;
  studiedAt: string;
  createdAt: string;
}

// ─── Daily schedule ───────────────────────────────────────────────────────────

export interface ScheduleBlock {
  topicId: string;
  topicName: string;
  subject: string;
  sessionType: "lecture" | "practice";
  durationMinutes: number;
  priorityScore: number;
  masteryScore: number;
}

export interface LocalDailySchedule {
  id: string;
  date: string; // YYYY-MM-DD
  blocks: ScheduleBlock[];
  scheduledHours: number;
  daysUntilExam: number;
  isReset: boolean;
  /** "nightly" = automated 11 pm job; "override" = manual button press */
  computedBy: "nightly" | "override";
  computedAt: string;
}

// ─── Telemetry events ─────────────────────────────────────────────────────────

export type TelemetryEventType =
  | "tab_focus"
  | "tab_blur"
  | "idle_start"
  | "idle_end"
  | "scroll"
  | "click"
  | "video_progress"
  | "session_start"
  | "session_end";

export interface LocalTelemetryEvent {
  id: string;
  type: TelemetryEventType;
  topicId: string | null;
  url: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Daily telemetry summary — pre-aggregated from raw events.
 * The scheduler reads this, not the raw events.
 */
export interface TelemetrySummary {
  date: string; // YYYY-MM-DD
  topicId: string;
  focusedMinutes: number;
  distractionMinutes: number;
  interactionCount: number;
  focusRatio: number;
  qualityScore: number;
}

// ─── Schedule overrides ───────────────────────────────────────────────────────

/** Audit record each time the user overrides the automatic schedule. */
export interface LocalScheduleOverride {
  id: string;
  date: string;
  reason: string | null;
  triggeredAt: string;
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

export interface MetaRecord {
  key: string;
  value: unknown;
}

/**
 * Keys stored in the meta store.
 * - "db_version"            : number
 * - "server_migration"      : "done" | "skipped" | null
 * - "last_nightly_run_date" : YYYY-MM-DD
 * - "schema_initialized_at" : ISO timestamp
 */
export type MetaKey =
  | "db_version"
  | "server_migration"
  | "last_nightly_run_date"
  | "schema_initialized_at";

// ─── Scheduler I/O ────────────────────────────────────────────────────────────

/** All inputs the scheduling algorithm needs to produce a DailySchedule. */
export interface SchedulerInput {
  profile: LocalStudentProfile;
  topics: LocalTopic[];
  /** Daily telemetry summaries from the last 7 days — used to update K and D */
  recentSummaries: TelemetrySummary[];
  targetDate: string; // YYYY-MM-DD
}

/** Returned by the scheduler in the Web Worker context */
export interface SchedulerResult {
  schedule: LocalDailySchedule;
  updatedProfile: Pick<LocalStudentProfile, "capacityScore" | "disciplineScore">;
  updatedTopics: Array<Pick<LocalTopic, "id" | "priorityScore">>;
}

// ─── Migration ────────────────────────────────────────────────────────────────

export type MigrationStatus = "available" | "running" | "done" | "skipped" | "error";

export interface MigrationResult {
  status: MigrationStatus;
  imported: { topics: number; sessions: number; profile: boolean };
  errors: string[];
}
