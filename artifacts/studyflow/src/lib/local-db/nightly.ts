/**
 * Nightly schedule recomputation — Phase 1
 *
 * The schedule is computed ONCE per day at 11 pm in the user's local timezone.
 * On-demand recalculation via the UI is an override and is rate-limited to
 * once per day. Every override is logged to the overrides store.
 *
 * Boot sequence (called from the React provider on app startup):
 *   1. Check if today's nightly run has already completed.
 *   2. If not, and it is past 11 pm, run immediately.
 *   3. If before 11 pm, schedule a setTimeout for tonight's 11 pm.
 *   4. Return a cleanup function to cancel any pending timer.
 */

import { MetaRepo, SchedulesRepo, OverridesRepo, ProfileRepo, TopicsRepo, TelemetryRepo } from "./repositories";
import { computeSchedule } from "./scheduler-algo";
import type { LocalDailySchedule, SchedulerInput, TelemetrySummary } from "./schema";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hour of day (local time) at which the nightly job fires */
const NIGHTLY_HOUR = 23; // 11 pm

/** Maximum number of manual override recalculations allowed per day */
export const DAILY_OVERRIDE_LIMIT = 1;

// ─── Core compute function ────────────────────────────────────────────────────

/**
 * Assembles a SchedulerInput from IndexedDB and runs computeSchedule.
 * Persists the resulting schedule and updates profile + topic priorities.
 *
 * @param computedBy - "nightly" for the scheduled job, "override" for UI button
 */
export async function runSchedulerJob(
  computedBy: "nightly" | "override" = "nightly",
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

  // Record last nightly run date
  await MetaRepo.set("last_nightly_run_date", today);

  return schedule;
}

// ─── Nightly scheduler ────────────────────────────────────────────────────────

/**
 * Returns the milliseconds until tonight's 11 pm in local time.
 * If it is already past 11 pm, returns 0.
 */
function msUntilNightlyRun(): number {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    NIGHTLY_HOUR,
    0,
    0,
    0,
  );
  const ms = target.getTime() - now.getTime();
  return ms > 0 ? ms : 0;
}

/**
 * Boot the nightly scheduler. Returns a cleanup function.
 *
 * Behaviour:
 * - Checks if today's nightly run has already happened.
 * - If not, and it is past 11 pm → runs immediately (missed run).
 * - If not, and before 11 pm → schedules a timer for tonight's 11 pm.
 * - After running, schedules the next nightly alarm (24 h loop).
 *
 * @param onScheduleReady - optional callback when a new schedule is computed
 */
export function startNightlyScheduler(
  onScheduleReady?: (schedule: LocalDailySchedule) => void,
): () => void {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  async function runAndScheduleNext() {
    try {
      const schedule = await runSchedulerJob("nightly");
      onScheduleReady?.(schedule);
    } catch (err) {
      console.error("[StudyFlow] Nightly scheduler failed:", err);
    }
    // Schedule the next run in ~24 h
    timerId = setTimeout(runAndScheduleNext, 24 * 60 * 60 * 1000);
  }

  async function boot() {
    const today = new Date().toISOString().split("T")[0];
    const lastRun = await MetaRepo.get<string>("last_nightly_run_date");

    if (lastRun === today) {
      // Already ran today — schedule for tomorrow night
      const msLeft = msUntilNightlyRun() + 24 * 60 * 60 * 1000;
      timerId = setTimeout(runAndScheduleNext, msLeft > 0 ? msLeft : 24 * 60 * 60 * 1000);
      return;
    }

    const nowHour = new Date().getHours();
    if (nowHour >= NIGHTLY_HOUR) {
      // Past 11 pm and not yet run — run immediately (missed run)
      await runAndScheduleNext();
    } else {
      // Schedule for tonight's 11 pm
      const ms = msUntilNightlyRun();
      timerId = setTimeout(runAndScheduleNext, ms);
    }
  }

  void boot();

  return () => {
    if (timerId !== null) clearTimeout(timerId);
  };
}

// ─── Override (manual recalculate) ───────────────────────────────────────────

/**
 * Manual override — recalculates today's schedule on demand.
 *
 * Rate-limited: returns null and the current override count if the daily
 * limit has already been reached. Logs an override record for audit.
 *
 * @returns { schedule, overrideCount } or { blocked: true, overrideCount }
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
