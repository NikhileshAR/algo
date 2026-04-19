import { db, schedulesTable, studySessionsTable, topicsTable } from "@workspace/db";
import { desc, eq, gte } from "drizzle-orm";

export type EngagementMode = "normal" | "low_capacity" | "reentry";

export interface IdentitySignal {
  streakDays: number;
  daysStudiedThisWeek: number;
  label: string;
  showUpMessage: string;
}

export interface AutonomyGuard {
  isEarned: boolean;
  consistencyScore: number;
  frictionMultiplier: number;
}

export interface ConfidenceCalibration {
  overconfidenceRatio: number;
  underconfidenceRatio: number;
  sessionTypeRecommendation: "more_practice" | "more_lecture" | "balanced";
}

export interface EngagementState {
  mode: EngagementMode;
  inactiveDays: number;
  identity: IdentitySignal;
  autonomyGuard: AutonomyGuard;
  confidenceCalibration: ConfidenceCalibration;
  emotionalFeedback: string;
  forecastActionMessage: string;
}

const REENTRY_INACTIVE_THRESHOLD = 2;
const LOW_CAPACITY_ADHERENCE_THRESHOLD = 0.35;
const AUTONOMY_CONSISTENCY_DAYS = 5;
const OVERCONFIDENCE_TOPIC_THRESHOLD = 0.3;
const UNDERCONFIDENCE_TOPIC_THRESHOLD = 0.3;
const CONFIDENCE_MASTERY_DELTA = 0.15;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function deriveIdentityLabel(daysStudiedThisWeek: number, streakDays: number): string {
  if (streakDays >= 7) return "Consistently excellent";
  if (daysStudiedThisWeek >= 5) return "Strong momentum";
  if (daysStudiedThisWeek >= 3) return "Building consistency";
  if (daysStudiedThisWeek >= 1) return "Getting started";
  return "Ready to restart";
}

function deriveShowUpMessage(daysStudiedThisWeek: number, streakDays: number): string {
  if (streakDays >= 7) return `You've shown up every day this week — that's a real habit now.`;
  if (daysStudiedThisWeek >= 5) return `You showed up ${daysStudiedThisWeek} days this week — strong commitment.`;
  if (daysStudiedThisWeek >= 3) return `You showed up ${daysStudiedThisWeek} days this week.`;
  if (daysStudiedThisWeek === 2) return "You showed up twice this week. Building from here.";
  if (daysStudiedThisWeek === 1) return "You showed up today. That matters.";
  return "Every session is a fresh start.";
}

function deriveEmotionalFeedback(params: {
  completionPct: number;
  daysStudiedThisWeek: number;
  streakDays: number;
  mode: EngagementMode;
}): string {
  if (params.mode === "reentry") {
    return "Welcome back. Starting small is the right move — just today's two blocks are enough.";
  }
  if (params.mode === "low_capacity") {
    return "Low-energy day detected. Tomorrow's plan will be lighter to help you recover.";
  }
  if (params.completionPct >= 100) {
    if (params.streakDays >= 3) return "Mission complete. You're building a real streak — keep going.";
    return "Mission complete. Great session today.";
  }
  if (params.completionPct >= 70) {
    if (params.daysStudiedThisWeek >= 4) return "Good consistency today — you're showing up regularly.";
    return "Solid progress today. The plan adapts tomorrow.";
  }
  if (params.completionPct >= 40) {
    if (params.daysStudiedThisWeek >= 4) return "You recovered well after a slow start — partial sessions compound.";
    return "Partial progress counts. The system adapts for tomorrow.";
  }
  return "Even showing up counts. Tomorrow starts fresh.";
}

function deriveForecastActionMessage(params: {
  fallingBehind: boolean;
  catchUpHoursPerDay: number;
  mode: EngagementMode;
}): string {
  if (params.mode === "reentry") {
    return "You've been away a few days — no backlog carried forward. Restart with just today's two blocks.";
  }
  if (params.fallingBehind) {
    const h = Math.max(0.1, Math.round(params.catchUpHoursPerDay * 10) / 10);
    return `You're slightly behind pace — adding ~${h}h/day this week will bring you back on track.`;
  }
  return "You're on track. Keep following today's sequence.";
}

export async function getEngagementState(params: {
  fallingBehind?: boolean;
  catchUpHoursPerDay?: number;
  completionPctToday?: number;
}): Promise<EngagementState> {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const since14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const since7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const recentSessions = await db
    .select()
    .from(studySessionsTable)
    .where(gte(studySessionsTable.studiedAt, since14))
    .orderBy(desc(studySessionsTable.studiedAt));

  const studiedDates = new Set(
    recentSessions.map((s) => new Date(s.studiedAt).toISOString().split("T")[0]),
  );

  // Current streak (starting from today)
  let streakDays = 0;
  const checkDate = new Date(now);
  while (studiedDates.has(checkDate.toISOString().split("T")[0])) {
    streakDays++;
    checkDate.setDate(checkDate.getDate() - 1);
  }

  // Days studied this week (last 7 days)
  const weekSessions = recentSessions.filter((s) => new Date(s.studiedAt) >= since7);
  const daysStudiedThisWeek = new Set(
    weekSessions.map((s) => new Date(s.studiedAt).toISOString().split("T")[0]),
  ).size;

  // Inactive days: consecutive days without sessions going backward from yesterday
  let inactiveDays = 0;
  const checkInactive = new Date(now);
  checkInactive.setDate(checkInactive.getDate() - 1);
  while (inactiveDays < 14) {
    const dayStr = checkInactive.toISOString().split("T")[0];
    if (studiedDates.has(dayStr)) break;
    inactiveDays++;
    checkInactive.setDate(checkInactive.getDate() - 1);
  }
  // Count today as inactive if no sessions logged yet
  const todaySessions = recentSessions.filter(
    (s) => new Date(s.studiedAt).toISOString().split("T")[0] === today,
  );
  if (todaySessions.length === 0) {
    inactiveDays++;
  }

  // Low-capacity detection: yesterday's completion < 35% of scheduled
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const [yesterdaySchedule] = await db
    .select()
    .from(schedulesTable)
    .where(eq(schedulesTable.date, yesterdayStr))
    .limit(1);

  const yesterdayActualMinutes = recentSessions
    .filter((s) => new Date(s.studiedAt).toISOString().split("T")[0] === yesterdayStr)
    .reduce((sum, s) => sum + s.durationMinutes, 0);

  const yesterdayScheduledMinutes = yesterdaySchedule
    ? Math.max(0, Math.round(yesterdaySchedule.scheduledHours * 60))
    : 0;

  const isLowCapacityDay =
    yesterdayScheduledMinutes >= 20 &&
    yesterdayActualMinutes < yesterdayScheduledMinutes * LOW_CAPACITY_ADHERENCE_THRESHOLD;

  // Engagement mode: re-entry takes priority over low-capacity
  let mode: EngagementMode = "normal";
  if (inactiveDays >= REENTRY_INACTIVE_THRESHOLD) {
    mode = "reentry";
  } else if (isLowCapacityDay) {
    mode = "low_capacity";
  }

  // Autonomy guard: earned if user studied ≥5 days in last 7
  const consistencyScore = clamp(daysStudiedThisWeek / AUTONOMY_CONSISTENCY_DAYS, 0, 1);
  const autonomyEarned = daysStudiedThisWeek >= AUTONOMY_CONSISTENCY_DAYS;
  // frictionMultiplier: 0.5 relaxed for consistent users, 1.0 full for others
  const frictionMultiplier = autonomyEarned ? 0.5 : 1.0;

  // Confidence calibration from topic data
  const topics = await db.select().from(topicsTable);
  const studiedTopics = topics.filter((t) => t.masteryScore > 0 || t.confidenceScore > 0);
  let overconfidentCount = 0;
  let underconfidentCount = 0;
  for (const t of studiedTopics) {
    if (t.confidenceScore - t.masteryScore > CONFIDENCE_MASTERY_DELTA) overconfidentCount++;
    else if (t.masteryScore - t.confidenceScore > CONFIDENCE_MASTERY_DELTA) underconfidentCount++;
  }
  const topicTotal = Math.max(studiedTopics.length, 1);
  const overconfidenceRatio = overconfidentCount / topicTotal;
  const underconfidenceRatio = underconfidentCount / topicTotal;
  let sessionTypeRecommendation: "more_practice" | "more_lecture" | "balanced" = "balanced";
  if (overconfidenceRatio > OVERCONFIDENCE_TOPIC_THRESHOLD) {
    sessionTypeRecommendation = "more_practice";
  } else if (underconfidenceRatio > UNDERCONFIDENCE_TOPIC_THRESHOLD) {
    sessionTypeRecommendation = "more_lecture";
  }

  const identityLabel = deriveIdentityLabel(daysStudiedThisWeek, streakDays);
  const showUpMessage = deriveShowUpMessage(daysStudiedThisWeek, streakDays);

  const completionPct = params.completionPctToday ?? 0;
  const emotionalFeedback = deriveEmotionalFeedback({
    completionPct,
    daysStudiedThisWeek,
    streakDays,
    mode,
  });

  const forecastActionMessage = deriveForecastActionMessage({
    fallingBehind: params.fallingBehind ?? false,
    catchUpHoursPerDay: params.catchUpHoursPerDay ?? 0,
    mode,
  });

  return {
    mode,
    inactiveDays,
    identity: {
      streakDays,
      daysStudiedThisWeek,
      label: identityLabel,
      showUpMessage,
    },
    autonomyGuard: {
      isEarned: autonomyEarned,
      consistencyScore: Math.round(consistencyScore * 1000) / 1000,
      frictionMultiplier,
    },
    confidenceCalibration: {
      overconfidenceRatio: Math.round(overconfidenceRatio * 1000) / 1000,
      underconfidenceRatio: Math.round(underconfidenceRatio * 1000) / 1000,
      sessionTypeRecommendation,
    },
    emotionalFeedback,
    forecastActionMessage,
  };
}
