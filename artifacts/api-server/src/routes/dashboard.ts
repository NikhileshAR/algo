import { Router, type IRouter } from "express";
import { db, studentProfileTable, topicsTable, studySessionsTable, schedulesTable } from "@workspace/db";
import { desc, eq, gte, sql } from "drizzle-orm";
import { ensureMasteryIntegrityOnLoad } from "../lib/mastery-integrity";
import { getEngagementState } from "../lib/engagement";

const router: IRouter = Router();

function daysUntil(examDate: string): number {
  const now = new Date();
  const exam = new Date(examDate);
  const diff = exam.getTime() - now.getTime();
  return Math.max(Math.ceil(diff / (1000 * 60 * 60 * 24)), 0);
}

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  await ensureMasteryIntegrityOnLoad();
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  if (!profile) {
    res.status(404).json({ error: "No profile found" });
    return;
  }

  const topics = await db.select().from(topicsTable);
  const totalTopics = topics.length;
  const completedTopics = topics.filter((t) => t.isCompleted).length;
  const averageMastery =
    totalTopics > 0 ? topics.reduce((sum, t) => sum + t.masteryScore, 0) / totalTopics : 0;

  const today = new Date().toISOString().split("T")[0];
  const [todaySchedule] = await db
    .select()
    .from(schedulesTable)
    .where(eq(schedulesTable.date, today))
    .limit(1);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const recentSessions = await db
    .select()
    .from(studySessionsTable)
    .where(gte(studySessionsTable.studiedAt, sevenDaysAgo));

  const weeklyStudiedHours = recentSessions.reduce(
    (sum, s) => sum + s.durationMinutes / 60,
    0,
  );

  const allSessions = await db
    .select()
    .from(studySessionsTable)
    .orderBy(desc(studySessionsTable.studiedAt));

  let streakDays = 0;
  if (allSessions.length > 0) {
    const studiedDates = new Set(
      allSessions.map((s) => new Date(s.studiedAt).toISOString().split("T")[0]),
    );
    const checkDate = new Date();
    while (studiedDates.has(checkDate.toISOString().split("T")[0])) {
      streakDays++;
      checkDate.setDate(checkDate.getDate() - 1);
    }
  }

  const engagement = await getEngagementState({
    fallingBehind: false,
    catchUpHoursPerDay: 0,
    completionPctToday: 0,
  });

  res.json({
    daysUntilExam: daysUntil(profile.examDate),
    totalTopics,
    completedTopics,
    averageMastery: Math.round(averageMastery * 100) / 100,
    disciplineScore: profile.disciplineScore,
    capacityScore: profile.capacityScore,
    todayScheduledHours: todaySchedule?.scheduledHours ?? 0,
    weeklyStudiedHours: Math.round(weeklyStudiedHours * 10) / 10,
    streakDays,
    examName: profile.examName,
    examDate: profile.examDate,
    engagement,
  });
});

router.get("/dashboard/weekly-progress", async (req, res): Promise<void> => {
  const days: Array<{ date: string; studiedHours: number; scheduledHours: number }> = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];

    const sessions = await db
      .select()
      .from(studySessionsTable)
      .where(
        sql`DATE(${studySessionsTable.studiedAt}) = ${dateStr}`,
      );

    const studiedHours = sessions.reduce((sum, s) => sum + s.durationMinutes / 60, 0);

    const [schedule] = await db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.date, dateStr))
      .limit(1);

    days.push({
      date: dateStr,
      studiedHours: Math.round(studiedHours * 10) / 10,
      scheduledHours: schedule?.scheduledHours ?? 0,
    });
  }

  res.json(days);
});

router.get("/dashboard/priority-topics", async (req, res): Promise<void> => {
  const topics = await db
    .select()
    .from(topicsTable)
    .orderBy(desc(topicsTable.priorityScore))
    .limit(5);

  res.json(
    topics.map((t) => ({
      ...t,
      prerequisites: JSON.parse(t.prerequisites ?? "[]"),
      lastStudiedAt: t.lastStudiedAt ? t.lastStudiedAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  );
});

export default router;
