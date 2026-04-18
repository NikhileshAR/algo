import { Router, type IRouter } from "express";
import { db, studySessionsTable, topicsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import {
  computePerformanceGap,
  getCurrentControlSnapshot,
  runSimulationComparison,
} from "../lib/control-loop";

const router: IRouter = Router();

/**
 * GET /api/analytics/velocity
 * Per-subject mastery velocity: how fast each subject is improving.
 * velocity = masteryScore / max(testsCount, 1) — avg gain per practice session.
 */
router.get("/analytics/velocity", async (_req, res): Promise<void> => {
  const topics = await db.select().from(topicsTable);

  const subjectMap = new Map<
    string,
    { mastery: number[]; testsCount: number; velocity: number[] }
  >();

  for (const t of topics) {
    if (!subjectMap.has(t.subject)) {
      subjectMap.set(t.subject, { mastery: [], testsCount: 0, velocity: [] });
    }
    const entry = subjectMap.get(t.subject)!;
    entry.mastery.push(t.masteryScore);
    entry.testsCount += t.testsCount;
    if (t.testsCount > 0) {
      entry.velocity.push(t.masteryScore / t.testsCount);
    }
  }

  const result = Array.from(subjectMap.entries()).map(([subject, d]) => ({
    subject,
    averageMastery: d.mastery.reduce((a, b) => a + b, 0) / d.mastery.length,
    totalTests: d.testsCount,
    velocityPerSession:
      d.velocity.length > 0
        ? d.velocity.reduce((a, b) => a + b, 0) / d.velocity.length
        : null,
    topicCount: d.mastery.length,
  }));

  result.sort((a, b) => (b.velocityPerSession ?? 0) - (a.velocityPerSession ?? 0));
  res.json(result);
});

/**
 * GET /api/analytics/study-patterns
 * Hour-of-day breakdown of study activity.
 * Returns count of sessions and total minutes studied per hour.
 */
router.get("/analytics/study-patterns", async (_req, res): Promise<void> => {
  const sessions = await db
    .select()
    .from(studySessionsTable)
    .orderBy(desc(studySessionsTable.studiedAt))
    .limit(500);

  const hourBuckets: Record<number, { count: number; totalMinutes: number }> = {};
  for (let h = 0; h < 24; h++) {
    hourBuckets[h] = { count: 0, totalMinutes: 0 };
  }

  for (const s of sessions) {
    const hour = new Date(s.studiedAt).getHours();
    hourBuckets[hour].count += 1;
    hourBuckets[hour].totalMinutes += s.durationMinutes;
  }

  const byHour = Object.entries(hourBuckets).map(([h, data]) => ({
    hour: parseInt(h),
    sessionCount: data.count,
    totalMinutes: data.totalMinutes,
  }));

  const sorted = byHour.filter((h) => h.sessionCount > 0).sort((a, b) => b.totalMinutes - a.totalMinutes);
  const peakHour = sorted[0]?.hour ?? null;

  res.json({ byHour, peakHour, totalSessions: sessions.length });
});

/**
 * GET /api/analytics/weekly-review
 * Full weekly review: sessions, subjects, recommendations.
 */
router.get("/analytics/weekly-review", async (_req, res): Promise<void> => {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const allSessions = await db
    .select()
    .from(studySessionsTable)
    .orderBy(desc(studySessionsTable.studiedAt))
    .limit(500);

  const weeklySessions = allSessions.filter(
    (s) => new Date(s.studiedAt) >= sevenDaysAgo,
  );
  const previousWeekSessions = allSessions.filter((s) => {
    const studiedAt = new Date(s.studiedAt);
    return studiedAt >= fourteenDaysAgo && studiedAt < sevenDaysAgo;
  });

  const topics = await db.select().from(topicsTable);

  const totalMinutes = weeklySessions.reduce((s, ss) => s + ss.durationMinutes, 0);
  const previousWeekMinutes = previousWeekSessions.reduce((s, ss) => s + ss.durationMinutes, 0);
  const practiceCount = weeklySessions.filter((s) => s.sessionType === "practice").length;
  const lectureCount = weeklySessions.filter((s) => s.sessionType === "lecture").length;
  const previousWeekPracticeCount = previousWeekSessions.filter((s) => s.sessionType === "practice").length;
  const previousWeekLectureCount = previousWeekSessions.filter((s) => s.sessionType === "lecture").length;

  const subjectMinutes: Record<string, number> = {};
  for (const s of weeklySessions) {
    const topic = topics.find((t) => t.id === s.topicId);
    const subject = topic?.subject ?? "Unknown";
    subjectMinutes[subject] = (subjectMinutes[subject] ?? 0) + s.durationMinutes;
  }

  const studiedTopicIds = new Set(weeklySessions.map((s) => s.topicId));
  const neglectedTopics = topics
    .filter((t) => !t.isCompleted && !studiedTopicIds.has(t.id))
    .sort((a, b) => a.masteryScore - b.masteryScore)
    .slice(0, 5);

  const lowestMastery = topics
    .filter((t) => !t.isCompleted)
    .sort((a, b) => a.masteryScore - b.masteryScore)
    .slice(0, 3);

  const avgMastery =
    topics.length > 0
      ? topics.reduce((s, t) => s + t.masteryScore, 0) / topics.length
      : 0;

  const daysWithStudy = new Set(
    weeklySessions.map((s) => new Date(s.studiedAt).toDateString()),
  ).size;
  const previousWeekDaysWithStudy = new Set(
    previousWeekSessions.map((s) => new Date(s.studiedAt).toDateString()),
  ).size;

  const dailyHours = Array.from({ length: 7 }).map((_, index) => {
    const date = new Date(sevenDaysAgo.getTime() + index * 24 * 60 * 60 * 1000);
    const dateKey = date.toDateString();
    const minutes = weeklySessions
      .filter((s) => new Date(s.studiedAt).toDateString() === dateKey)
      .reduce((sum, s) => sum + s.durationMinutes, 0);
    return {
      date: date.toISOString().split("T")[0],
      label: date.toLocaleDateString("en-US", { weekday: "short" }),
      minutes,
      hours: Math.round((minutes / 60) * 10) / 10,
    };
  });

  const firstHalfHours = dailyHours.slice(0, 3).reduce((sum, d) => sum + d.hours, 0);
  const secondHalfHours = dailyHours.slice(3).reduce((sum, d) => sum + d.hours, 0);
  const consistencyDroppedMidWeek = secondHalfHours + 0.3 < firstHalfHours;
  const skippedPracticeSessions = practiceCount === 0 && lectureCount > 0;

  let recoveryDays = 0;
  let currentBreak = 0;
  for (const day of dailyHours) {
    if (day.minutes === 0) {
      currentBreak += 1;
    } else if (currentBreak > 0) {
      recoveryDays = currentBreak;
      break;
    }
  }

  res.json({
    weeklySessions: weeklySessions.map((s) => ({
      ...s,
      studiedAt: s.studiedAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
    })),
    totalMinutes,
    totalHours: totalMinutes / 60,
    previousWeekMinutes,
    previousWeekHours: previousWeekMinutes / 60,
    practiceCount,
    lectureCount,
    previousWeekPracticeCount,
    previousWeekLectureCount,
    daysWithStudy,
    previousWeekDaysWithStudy,
    subjectBreakdown: Object.entries(subjectMinutes)
      .map(([subject, minutes]) => ({ subject, minutes }))
      .sort((a, b) => b.minutes - a.minutes),
    dailyHours,
    consistencyDroppedMidWeek,
    skippedPracticeSessions,
    recoveryDays,
    neglectedTopics,
    lowestMastery,
    averageMastery: avgMastery,
    totalTopics: topics.length,
    completedTopics: topics.filter((t) => t.isCompleted).length,
  });
});

/**
 * GET /api/analytics/control-loop
 * Snapshot of forecast + gap + calibration from the control layer.
 */
router.get("/analytics/control-loop", async (_req, res): Promise<void> => {
  const snapshot = await getCurrentControlSnapshot();
  res.json(snapshot);
});

/**
 * GET /api/analytics/performance-gap
 * Expected vs actual behavior deviations for recent history.
 */
router.get("/analytics/performance-gap", async (req, res): Promise<void> => {
  const days = Number.isFinite(Number(req.query.days))
    ? Math.max(1, Math.min(90, Number(req.query.days)))
    : 14;
  const gap = await computePerformanceGap(days);
  res.json(gap);
});

/**
 * GET /api/analytics/experiments
 * Runs random/static/adaptive simulations on identical compliance sequence.
 */
router.get("/analytics/experiments", async (req, res): Promise<void> => {
  const horizonDays = Number.isFinite(Number(req.query.days))
    ? Math.max(1, Math.min(365, Number(req.query.days)))
    : 180;
  const seed = typeof req.query.seed === "string" ? req.query.seed : undefined;
  const comparison = await runSimulationComparison({ horizonDays, seed });
  res.json(comparison);
});

export default router;
