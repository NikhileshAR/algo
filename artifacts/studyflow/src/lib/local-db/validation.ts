import { computeMomentumState, loadMomentumData } from "@/lib/execution-engine";
import {
  getDb,
  VALIDATION_DAILY_STORE,
  VALIDATION_DROPOFF_STORE,
  VALIDATION_EXECUTION_EVENT_STORE,
  VALIDATION_RESET_STORE,
  VALIDATION_WEEKLY_STORE,
} from "./idb";
import type {
  DailyOutcomeSnapshotRecord,
  DropoffEventRecord,
  ResetImpactRecord,
  ValidationExecutionEvent,
  ValidationMode,
  WeeklyValidationSummaryRecord,
} from "./schema";

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, precision = 3): number {
  const p = 10 ** precision;
  return Math.round(value * p) / p;
}

function toDay(date = new Date()): string {
  return date.toISOString().split("T")[0];
}

function dayOffset(base: string, offset: number): string {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0];
}

function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await getDb();
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result ?? []) as T[]);
    req.onerror = () => reject(req.error ?? new Error(`Failed to read ${storeName}`));
  });
}

async function getByIndex<T>(storeName: string, indexName: string, query: IDBValidKey): Promise<T | null> {
  const db = await getDb();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).index(indexName).get(query);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error(`Failed to read ${storeName} by index`));
  });
}

async function putToStore<T>(storeName: string, value: T): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`Failed to write ${storeName}`));
  });
}

function latestByDate(rows: DailyOutcomeSnapshotRecord[]): DailyOutcomeSnapshotRecord[] {
  const map = new Map<string, DailyOutcomeSnapshotRecord>();
  for (const row of rows) {
    const existing = map.get(row.date);
    if (!existing || existing.timestamp < row.timestamp) {
      map.set(row.date, row);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Need at least 4 samples to split into two periods for directional trend checks.
const MIN_ROWS_FOR_TREND = 4;
// 0.15h (~9 minutes) separates meaningful movement from day-level noise.
const CAPACITY_TREND_THRESHOLD_HOURS = 0.15;
// 3+ inactive days is treated as behavioral drop-off for this phase.
const DROPOFF_INACTIVITY_THRESHOLD_DAYS = 3;

function capacityTrend(rows: DailyOutcomeSnapshotRecord[]): "upward" | "flat" | "declining" {
  if (rows.length < MIN_ROWS_FOR_TREND) return "flat";
  const half = Math.floor(rows.length / 2);
  const first = rows.slice(0, half);
  const second = rows.slice(half);
  const firstSignal = avg(first.map((r) => (r.actual_hours + r.capacity_estimate) / 2));
  const secondSignal = avg(second.map((r) => (r.actual_hours + r.capacity_estimate) / 2));
  const delta = secondSignal - firstSignal;
  if (delta > CAPACITY_TREND_THRESHOLD_HOURS) return "upward";
  if (delta < -CAPACITY_TREND_THRESHOLD_HOURS) return "declining";
  return "flat";
}

function recoveryAfterResetDays(rows: DailyOutcomeSnapshotRecord[]): number | null {
  const resetRows = rows.filter((r) => r.reset_triggered);
  if (resetRows.length === 0) return null;
  const values: number[] = [];
  for (const reset of resetRows) {
    const before = rows.filter((r) => r.date < reset.date).slice(-3);
    const baseline = before.length > 0 ? avg(before.map((r) => r.completion_rate)) : 0.6;
    const after = rows.filter((r) => r.date > reset.date).slice(0, 7);
    const recovered = after.find((r) => r.completion_rate >= Math.max(0.5, baseline));
    if (recovered) {
      values.push(dayDiff(reset.date, recovered.date));
    }
  }
  if (values.length === 0) return null;
  return round(avg(values), 2);
}

function recoveryAfterFailureDays(rows: DailyOutcomeSnapshotRecord[]): number | null {
  const values: number[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i];
    const isMissed = row.actual_hours <= 0 && row.sessions_completed === 0;
    if (!isMissed) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      if (next.actual_hours > 0 || next.sessions_completed > 0) {
        values.push(dayDiff(row.date, next.date));
        break;
      }
    }
  }
  if (values.length === 0) return null;
  return round(avg(values), 2);
}

function weeklyWindow(latestDate: string): { start: string; end: string } {
  return { start: dayOffset(latestDate, -6), end: latestDate };
}

export class ValidationRepo {
  async appendExecutionEvent(input: { mode: ValidationMode; date?: string; type: "started" | "interrupted" }): Promise<void> {
    const event: ValidationExecutionEvent = {
      id: genId("val-exec"),
      mode: input.mode,
      date: input.date ?? toDay(),
      type: input.type,
      timestamp: new Date().toISOString(),
    };
    await putToStore(VALIDATION_EXECUTION_EVENT_STORE, event);
  }

  async executionEventsForDay(mode: ValidationMode, date: string): Promise<ValidationExecutionEvent[]> {
    const all = await getAllFromStore<ValidationExecutionEvent>(VALIDATION_EXECUTION_EVENT_STORE);
    return all
      .filter((e) => e.mode === mode && e.date === date)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async appendDailySnapshot(input: Omit<DailyOutcomeSnapshotRecord, "id" | "timestamp">): Promise<DailyOutcomeSnapshotRecord> {
    const row: DailyOutcomeSnapshotRecord = {
      ...input,
      id: genId("val-day"),
      timestamp: new Date().toISOString(),
    };
    await putToStore(VALIDATION_DAILY_STORE, row);
    return row;
  }

  async dailySnapshots(mode: ValidationMode): Promise<DailyOutcomeSnapshotRecord[]> {
    const rows = await getAllFromStore<DailyOutcomeSnapshotRecord>(VALIDATION_DAILY_STORE);
    return latestByDate(rows.filter((row) => row.mode === mode));
  }

  async appendResetImpact(input: Omit<ResetImpactRecord, "id" | "timestamp">): Promise<void> {
    const existing = await getByIndex<ResetImpactRecord>(
      VALIDATION_RESET_STORE,
      "reset_mode",
      [input.reset_date, input.mode],
    );
    if (existing) return;
    await putToStore<ResetImpactRecord>(VALIDATION_RESET_STORE, {
      ...input,
      id: genId("val-reset"),
      timestamp: new Date().toISOString(),
    });
  }

  async appendDropoff(input: Omit<DropoffEventRecord, "id" | "timestamp">): Promise<void> {
    const existing = await getByIndex<DropoffEventRecord>(
      VALIDATION_DROPOFF_STORE,
      "lastdate_mode",
      [input.last_date, input.mode],
    );
    if (existing) return;
    await putToStore<DropoffEventRecord>(VALIDATION_DROPOFF_STORE, {
      ...input,
      id: genId("val-dropoff"),
      timestamp: new Date().toISOString(),
    });
  }

  async appendWeeklySummary(input: Omit<WeeklyValidationSummaryRecord, "id" | "timestamp">): Promise<WeeklyValidationSummaryRecord> {
    const existing = await getByIndex<WeeklyValidationSummaryRecord>(
      VALIDATION_WEEKLY_STORE,
      "week_mode",
      [input.week_start, input.week_end, input.mode],
    );
    if (existing) return existing;
    const row: WeeklyValidationSummaryRecord = {
      ...input,
      id: genId("val-week"),
      timestamp: new Date().toISOString(),
    };
    await putToStore(VALIDATION_WEEKLY_STORE, row);
    return row;
  }

  async weeklySummaries(mode?: ValidationMode): Promise<WeeklyValidationSummaryRecord[]> {
    const rows = await getAllFromStore<WeeklyValidationSummaryRecord>(VALIDATION_WEEKLY_STORE);
    return rows
      .filter((row) => (mode ? row.mode === mode : true))
      .sort((a, b) => b.week_end.localeCompare(a.week_end));
  }
}

let singleton: ValidationRepo | null = null;
export function getValidationRepo(): ValidationRepo {
  if (!singleton) singleton = new ValidationRepo();
  return singleton;
}

export async function runValidationPipeline(params: {
  mode: ValidationMode;
  date?: string;
  plannedHours: number;
  actualHours: number;
  sessionsCompleted: number;
  resetTriggered: boolean;
  disciplineScore: number;
  capacityEstimate: number;
  highPriorityProgress: number | null;
  backlogLevel: number;
}): Promise<void> {
  const repo = getValidationRepo();
  const date = params.date ?? toDay();
  const events = await repo.executionEventsForDay(params.mode, date);
  const startedCount = events.filter((e) => e.type === "started").length;
  const interruptedCount = events.filter((e) => e.type === "interrupted").length;
  const momentumData = loadMomentumData(date);
  // Momentum state is stored per day so validation can correlate behavioral
  // continuity/breaks with completion and recovery outcomes.
  const momentum = computeMomentumState(
    momentumData.consecutiveCompleted,
    momentumData.lastWasInterrupted,
  );
  const fallbackCompletionRate = params.plannedHours > 0 ? clamp(params.actualHours / params.plannedHours) : 0;
  const completionRate = startedCount > 0 ? clamp(params.sessionsCompleted / startedCount) : fallbackCompletionRate;

  await repo.appendDailySnapshot({
    mode: params.mode,
    date,
    planned_hours: round(params.plannedHours, 2),
    actual_hours: round(params.actualHours, 2),
    completion_rate: round(completionRate),
    sessions_completed: params.sessionsCompleted,
    sessions_started: startedCount,
    interruptions: interruptedCount,
    reset_triggered: params.resetTriggered,
    momentum_state: momentum,
    discipline_score: round(params.disciplineScore),
    capacity_estimate: round(params.capacityEstimate, 2),
  });

  const snapshots = await repo.dailySnapshots(params.mode);
  if (snapshots.length === 0) return;
  const latest = snapshots[snapshots.length - 1];
  const window = weeklyWindow(latest.date);
  const weekRows = snapshots.filter((row) => row.date >= window.start && row.date <= window.end);
  if (weekRows.length === 0) return;

  const totalHours = weekRows.reduce((sum, row) => sum + row.actual_hours, 0);
  const totalCompleted = weekRows.reduce((sum, row) => sum + row.sessions_completed, 0);
  const totalStartedCount = weekRows.reduce((sum, row) => sum + row.sessions_started, 0);
  const activeDays = weekRows.filter((row) => row.actual_hours > 0 || row.sessions_completed > 0).length;
  const avgSessionCompletionPct = avg(
    weekRows.map((row) => (row.sessions_started > 0 ? row.sessions_completed / row.sessions_started : 0)),
  );
  const resetCount = weekRows.filter((row) => row.reset_triggered).length;
  const resetRecovery = recoveryAfterResetDays(weekRows);
  const failureRecovery = recoveryAfterFailureDays(weekRows);

  await repo.appendWeeklySummary({
    mode: params.mode,
    week_start: window.start,
    week_end: window.end,
    total_study_hours: round(totalHours, 2),
    average_completion_rate: round(avg(weekRows.map((row) => row.completion_rate))),
    consistency: round(activeDays / 7),
    average_session_completion_pct: round(avgSessionCompletionPct),
    resets_triggered: resetCount,
    recovery_after_reset_days: resetRecovery,
    completion_rate_metric: totalStartedCount > 0 ? round(totalCompleted / totalStartedCount) : 0,
    effective_study_hours: round(totalHours, 2),
    recovery_after_failure_days: failureRecovery,
    high_priority_progress: params.highPriorityProgress !== null ? round(params.highPriorityProgress) : null,
    capacity_trend: capacityTrend(weekRows),
  });

  for (const reset of weekRows.filter((row) => row.reset_triggered)) {
    const before = weekRows.filter((row) => row.date < reset.date).slice(-3);
    const after = weekRows.filter((row) => row.date > reset.date).slice(0, 3);
    if (before.length === 0 || after.length === 0) continue;
    const beforeCompletion = avg(before.map((row) => row.completion_rate));
    const afterCompletion = avg(after.map((row) => row.completion_rate));
    const beforeHours = avg(before.map((row) => row.actual_hours));
    const afterHours = avg(after.map((row) => row.actual_hours));
    await repo.appendResetImpact({
      mode: params.mode,
      reset_date: reset.date,
      before_completion_rate: round(beforeCompletion),
      after_completion_rate: round(afterCompletion),
      completion_rate_change: round(afterCompletion - beforeCompletion),
      before_hours: round(beforeHours, 2),
      after_hours: round(afterHours, 2),
      hours_change: round(afterHours - beforeHours, 2),
    });
  }

  const lastActive = [...snapshots].reverse().find((row) => row.actual_hours > 0 || row.sessions_completed > 0);
  if (lastActive) {
    const inactivityDays = dayDiff(lastActive.date, date);
    if (inactivityDays >= DROPOFF_INACTIVITY_THRESHOLD_DAYS) {
      await repo.appendDropoff({
        mode: params.mode,
        inactivity_days: inactivityDays,
        last_date: lastActive.date,
        last_known_state: lastActive.actual_hours > 0 ? "active" : "paused",
        backlog_level: round(params.backlogLevel),
        momentum_state: lastActive.momentum_state,
      });
    }
  }
}
