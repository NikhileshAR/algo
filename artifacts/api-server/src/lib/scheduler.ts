import { db, topicsTable, studentProfileTable, schedulesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "./logger";

export interface ScheduleBlock {
  topicId: number;
  topicName: string;
  subject: string;
  sessionType: "lecture" | "practice";
  durationMinutes: number;
  priorityScore: number;
  masteryScore: number;
}

function parseDeps(prerequisites: string): number[] {
  try {
    return JSON.parse(prerequisites) as number[];
  } catch {
    return [];
  }
}

function daysSinceStudied(lastStudiedAt: Date | null): number {
  if (!lastStudiedAt) return 999;
  const diff = Date.now() - new Date(lastStudiedAt).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Ebbinghaus forgetting curve: R = e^(-t/S)
 * Stability S scales with mastery: well-mastered topics retain longer.
 * mastery=0 → S=3 days, mastery=1 → S=21 days
 */
function forgettingRetention(mastery: number, days: number): number {
  const stability = 3 + mastery * 18;
  return Math.exp(-days / stability);
}

function computePriority(
  mastery: number,
  difficulty: number,
  estimatedHours: number,
  daysUntilExam: number,
  disciplineScore: number,
  lastStudiedAt: Date | null,
): number {
  const days = daysSinceStudied(lastStudiedAt);
  const retention = forgettingRetention(mastery, days);

  // Effective mastery decays if topic hasn't been reviewed
  const effectiveMastery = mastery * retention;

  const urgency = daysUntilExam > 0 ? estimatedHours / daysUntilExam : estimatedHours;
  const knowledgeGap = 1 - effectiveMastery;
  const difficultyWeight = difficulty / 5;
  const discFactor = 1 / Math.max(disciplineScore, 0.1);

  // Recency boost: topics dormant > 7 days get an extra nudge
  const recencyBoost = days > 7 ? 1 + (days - 7) / 14 : 1;

  return urgency * knowledgeGap * difficultyWeight * discFactor * recencyBoost;
}

function daysUntil(examDate: string): number {
  const now = new Date();
  const exam = new Date(examDate);
  const diff = exam.getTime() - now.getTime();
  return Math.max(Math.ceil(diff / (1000 * 60 * 60 * 24)), 0);
}

function geometricCapacity(baseCapacity: number, disciplineScore: number): number {
  return baseCapacity * (0.6 + 0.4 * disciplineScore);
}

export async function recalculateSchedule(): Promise<{
  date: string;
  scheduledHours: number;
  blocks: ScheduleBlock[];
  daysUntilExam: number;
  isReset: boolean;
}> {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  if (!profile) {
    return {
      date: new Date().toISOString().split("T")[0],
      scheduledHours: 0,
      blocks: [],
      daysUntilExam: 0,
      isReset: false,
    };
  }

  const topics = await db.select().from(topicsTable);
  const days = daysUntil(profile.examDate);

  const scheduledHours = geometricCapacity(profile.capacityScore, profile.disciplineScore);
  const totalMinutes = Math.round(scheduledHours * 60);

  const topicsWithDeps = topics
    .filter((t) => !t.isCompleted)
    .map((t) => {
      const deps = parseDeps(t.prerequisites);
      const allDepsComplete = deps.every((depId) => {
        const dep = topics.find((x) => x.id === depId);
        return dep ? dep.masteryScore >= 0.6 || dep.isCompleted : true;
      });
      const priority = allDepsComplete
        ? computePriority(t.masteryScore, t.difficultyLevel, t.estimatedHours, days, profile.disciplineScore, t.lastStudiedAt)
        : 0;
      return { ...t, priority, allDepsComplete };
    })
    .sort((a, b) => b.priority - a.priority);

  const blocks: ScheduleBlock[] = [];
  let usedMinutes = 0;

  for (const topic of topicsWithDeps) {
    if (usedMinutes >= totalMinutes) break;
    if (!topic.allDepsComplete) continue;

    const sessionType: "lecture" | "practice" =
      profile.activePracticeRatio >= 0.5 && topic.masteryScore > 0.3 ? "practice" : "lecture";

    const baseMinutes = Math.min(
      Math.round(Math.min(topic.estimatedHours * 60, 90)),
      totalMinutes - usedMinutes,
    );
    if (baseMinutes < 15) continue;

    blocks.push({
      topicId: topic.id,
      topicName: topic.name,
      subject: topic.subject,
      sessionType,
      durationMinutes: baseMinutes,
      priorityScore: topic.priority,
      masteryScore: topic.masteryScore,
    });

    usedMinutes += baseMinutes;
  }

  logger.info({ blocks: blocks.length, scheduledHours }, "Schedule recalculated");

  return {
    date: new Date().toISOString().split("T")[0],
    scheduledHours,
    blocks,
    daysUntilExam: days,
    isReset: false,
  };
}

export async function applyMasteryUpdate(
  topicId: number,
  testScore: number,
  testScoreMax: number,
): Promise<{ masteryBefore: number; masteryAfter: number }> {
  const [topic] = await db.select().from(topicsTable).where(eq(topicsTable.id, topicId));
  if (!topic) return { masteryBefore: 0, masteryAfter: 0 };

  const masteryBefore = topic.masteryScore;
  const nt = topic.testsCount + 1;
  const alpha = 1 / nt;
  const normalizedScore = testScore / Math.max(testScoreMax, 1);
  const newMastery = topic.masteryScore + alpha * (normalizedScore - topic.masteryScore);
  const masteryAfter = Math.min(Math.max(newMastery, 0), 1);

  // Confidence score grows with practice attempts: asymptotes toward 1
  // after ~20 tests. Uses Wilson-style formula: nt / (nt + 10)
  const newConfidence = nt / (nt + 10);

  await db
    .update(topicsTable)
    .set({
      masteryScore: masteryAfter,
      testsCount: nt,
      confidenceScore: newConfidence,
      updatedAt: new Date(),
    })
    .where(eq(topicsTable.id, topicId));

  await recomputePriorities();
  return { masteryBefore, masteryAfter };
}

export async function recomputePriorities(): Promise<void> {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  const topics = await db.select().from(topicsTable);
  if (!profile) return;

  const days = daysUntil(profile.examDate);

  for (const topic of topics) {
    const priority = computePriority(
      topic.masteryScore,
      topic.difficultyLevel,
      topic.estimatedHours,
      days,
      profile.disciplineScore,
      topic.lastStudiedAt,
    );
    await db
      .update(topicsTable)
      .set({ priorityScore: priority })
      .where(eq(topicsTable.id, topic.id));
  }
}

export async function updateCapacityAndDiscipline(
  actualHours: number,
): Promise<void> {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  if (!profile) return;

  const newCapacity = 0.8 * profile.capacityScore + 0.2 * actualHours;
  const newDiscipline = Math.min(actualHours / Math.max(profile.dailyTargetHours, 0.1), 1);
  const practiceRatio = Math.min(Math.max(profile.activePracticeRatio * 0.9 + 0.1, 0), 1);

  await db
    .update(studentProfileTable)
    .set({
      capacityScore: newCapacity,
      disciplineScore: newDiscipline,
      activePracticeRatio: practiceRatio,
      updatedAt: new Date(),
    })
    .where(eq(studentProfileTable.id, profile.id));
}
