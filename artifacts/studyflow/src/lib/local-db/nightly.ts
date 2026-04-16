/**
 * Schedule computation — Phase 1 (revised)
 *
 * LAZY / DETERMINISTIC MODEL
 * ──────────────────────────
 * The old "setTimeout at 11 pm" approach was replaced because:
 *   - Browsers sleep background tabs
 *   - Laptops shut down
 *   - The tab may not be open at a specific clock time
 *
 * Instead, scheduling is LAZY and DETERMINISTIC:
 *
 *   On every app open → ensureTodaySchedule()
 *     If today already has a schedule → return it immediately (no-op).
 *     If today has no schedule → compute now, persist, return it.
 *
 * This is equivalent to "nightly compute" but works offline-first:
 * the schedule is generated the first time the user opens the app each day,
 * using the full telemetry history available at that moment.
 *
 * Override (manual recalculate button):
 *   - Rate-limited to once per day
 *   - Logs an audit record
 */

import { MetaRepo, SchedulesRepo, OverridesRepo, ProfileRepo, TopicsRepo, TelemetryRepo } from "./repositories";
import { computeSchedule } from "./scheduler-algo";
import type { LocalDailySchedule, SchedulerInput, TelemetrySummary } from "./schema";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of manual override recalculations allowed per day */
export const DAILY_OVERRIDE_LIMIT = 1;

// ─── Core compute function ────────────────────────────────────────────────────

/**
 * Assembles a SchedulerInput from IndexedDB and runs computeSchedule.
 * Persists the resulting schedule and updates profile + topic priorities.
 *
 * @param computedBy - "lazy_open" for the automatic path, "override" for UI button
 */
export async function runSchedulerJob(
  computedBy: "lazy_open" | "override" = "lazy_open",
): Promise<LocalDailySchedule> {
  const [profile, topics] = await Promise.all([
    ProfileRepo.get(),
    TopicsRepo.list(),
  ]);

  if (!profile) {
    throw new Error("No student profile found — complete onboarding first.");
  }

  // Collect last-7-day telemetry summaries
  const summaries: TelemetrySummary[] = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.now() - d * 86_400_000).toISOString().split("T")[0];
    const events = await TelemetryRepo.listForDate(date);
    if (events.length > 0) {
      summaries.push(...TelemetryRepo.summarizeDay(events));
    }
  }

  const today = new Date().toISOString().split("T")[0];
  const input: SchedulerInput = {
    profile,
    topics,
    recentSummaries: summaries,
    targetDate: today,
  };

  const result = computeSchedule(input);

  // Persist the schedule
  const schedule: LocalDailySchedule = {
    ...result.schedule,
    computedBy,
  };
  await SchedulesRepo.save(schedule);

  // Update profile capacity + discipline
  await ProfileRepo.patch(result.updatedProfile);

  // Update per-topic priority scores
  for (const { id, priorityScore } of result.updatedTopics) {
    await TopicsRepo.update(id, { priorityScore });
  }

  // Record the date of the last computed schedule
  await MetaRepo.set("last_schedule_date", today);

  return schedule;
}

// ─── Lazy open-time trigger ───────────────────────────────────────────────────

/**
 * Called on every app open. Ensures today's schedule exists.
 *
 * Algorithm (lazy + deterministic):
 *   1. Does a schedule for today already exist in IndexedDB?
 *      YES → return it immediately (no computation, no network call)
 *      NO  → compute now, persist, return
 *
 * This replaces the old "setTimeout at 11 pm" approach which was fragile
 * because the tab may not be open at that exact time. The lazy approach
 * guarantees the schedule is always generated the first time the app opens
 * on any given day — regardless of what time that is.
 *
 * @param onScheduleReady - optional callback when a schedule is freshly computed
 * @returns The existing or newly computed schedule, or null if no profile exists
 */
export async function ensureTodaySchedule(
  onScheduleReady?: (schedule: LocalDailySchedule) => void,
): Promise<LocalDailySchedule | null> {
  const today = new Date().toISOString().split("T")[0];

  // Fast path: schedule already exists
  const existing = await SchedulesRepo.getByDate(today);
  if (existing) return existing;

  // No profile yet — onboarding not done
  const profile = await ProfileRepo.get();
  if (!profile) return null;

  // No topics yet — nothing to schedule
  const topics = await TopicsRepo.list();
  if (topics.length === 0) return null;

  // Compute lazily on first open of the day
  try {
    const schedule = await runSchedulerJob("lazy_open");
    onScheduleReady?.(schedule);
    return schedule;
  } catch (err) {
    console.error("[StudyFlow] Lazy schedule compute failed:", err);
    return null;
  }
}

// ─── Override (manual recalculate) ───────────────────────────────────────────

/**
 * Manual override — recalculates today's schedule on demand.
 *
 * Rate-limited: returns { blocked: true } if the daily limit has already
 * been reached. Logs an override record for audit.
 */
export async function requestOverride(
  reason: string | null = null,
): Promise<
  | { schedule: LocalDailySchedule; overrideCount: number }
  | { blocked: true; overrideCount: number }
> {
  const overrideCount = await OverridesRepo.countToday();

  if (overrideCount >= DAILY_OVERRIDE_LIMIT) {
    return { blocked: true, overrideCount };
  }

  await OverridesRepo.create(reason);
  const schedule = await runSchedulerJob("override");

  // Increment the profile's cumulative override counter
  const profile = await ProfileRepo.get();
  if (profile) {
    await ProfileRepo.patch({ overrideCount: profile.overrideCount + 1 });
  }

  return { schedule, overrideCount: overrideCount + 1 };
}

