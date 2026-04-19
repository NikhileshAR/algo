import { Router, type IRouter } from "express";
import { db, schedulesTable, topicOverridesTable, topicsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { recalculateSchedule, type SchedulerMode } from "../lib/scheduler";
import { getCurrentControlSnapshot } from "../lib/control-loop";
import { ensureMasteryIntegrityOnLoad } from "../lib/mastery-integrity";
import { z } from "zod/v4";

const router: IRouter = Router();
const SWAP_SOFT_LIMIT_PER_DAY = 2;

interface SwapCandidate {
  id: number;
  subject: string;
  difficultyLevel: number;
  priorityScore: number;
}

function formatSchedule(s: typeof schedulesTable.$inferSelect) {
  return {
    ...s,
    blocks: JSON.parse(s.blocks ?? "[]"),
    createdAt: s.createdAt.toISOString(),
  };
}

function parseMode(raw: unknown): SchedulerMode {
  if (raw === "static" || raw === "random" || raw === "adaptive") {
    return raw;
  }
  return "adaptive";
}

async function getOverrideBudget(scheduleDate: string): Promise<{ used: number; softLimit: number }> {
  const rows = await db
    .select()
    .from(topicOverridesTable)
    .where(eq(topicOverridesTable.scheduleDate, scheduleDate));
  return { used: rows.length, softLimit: SWAP_SOFT_LIMIT_PER_DAY };
}

function scoreSwapCandidate(current: SwapCandidate, candidate: SwapCandidate): number {
  const sameSubjectBonus = candidate.subject === current.subject ? 1 : 0;
  const priorityDistance = Math.abs((candidate.priorityScore ?? 0) - (current.priorityScore ?? 0));
  const difficultyDistance = Math.abs((candidate.difficultyLevel ?? 3) - (current.difficultyLevel ?? 3));
  return sameSubjectBonus * 2 - priorityDistance * 1.2 - difficultyDistance * 0.35;
}

function getRecommendedAlternatives(
  current: SwapCandidate,
  topics: Array<typeof topicsTable.$inferSelect>,
): number[] {
  const ranked = topics
    .filter((topic) => topic.id !== current.id && !topic.isCompleted)
    .map((topic) => ({
      id: topic.id,
      score: scoreSwapCandidate(current, {
        id: topic.id,
        subject: topic.subject,
        difficultyLevel: topic.difficultyLevel,
        priorityScore: topic.priorityScore,
      }),
    }))
    .sort((a, b) => b.score - a.score);
  const sameSubject = ranked.filter((item) => {
    const t = topics.find((topic) => topic.id === item.id);
    return t?.subject === current.subject;
  });
  const fallback = ranked.filter((item) => !sameSubject.some((preferred) => preferred.id === item.id));
  return [...sameSubject, ...fallback].slice(0, 5).map((item) => item.id);
}

async function getStaticTopicOrder(mode: SchedulerMode): Promise<number[] | undefined> {
  if (mode !== "static") {
    return undefined;
  }
  const topics = await db.select().from(topicsTable).orderBy(desc(topicsTable.priorityScore));
  return topics.map((topic) => topic.id);
}

router.get("/schedule/today", async (req, res): Promise<void> => {
  await ensureMasteryIntegrityOnLoad();
  const today = new Date().toISOString().split("T")[0];

  const [existing] = await db
    .select()
    .from(schedulesTable)
    .where(eq(schedulesTable.date, today))
    .orderBy(desc(schedulesTable.createdAt))
    .limit(1);

  if (existing) {
    const snapshot = await getCurrentControlSnapshot();
    const overrideBudget = await getOverrideBudget(existing.date);
    res.json({
      ...formatSchedule(existing),
      overrideBudget,
      control: snapshot,
    });
    return;
  }

  const mode = parseMode(req.query.mode);
  const snapshot = await getCurrentControlSnapshot();
  const staticTopicOrder = await getStaticTopicOrder(mode);
  const scheduleData = await recalculateSchedule({
    mode,
    staticTopicOrder,
    tuning: snapshot.calibration.tuning,
    forceIntervention: snapshot.forecast.riskSignal.intervention,
  });

  const [created] = await db
    .insert(schedulesTable)
    .values({
      date: scheduleData.date,
      scheduledHours: scheduleData.scheduledHours,
      blocks: JSON.stringify(scheduleData.blocks),
      daysUntilExam: scheduleData.daysUntilExam,
      isReset: scheduleData.isReset,
    })
    .returning();

  res.json({
    ...formatSchedule(created),
    overrideBudget: await getOverrideBudget(today),
    mode,
    riskSignal: scheduleData.riskSignal,
    control: snapshot,
  });
});

router.post("/schedule/today", async (req, res): Promise<void> => {
  await ensureMasteryIntegrityOnLoad();
  const mode = parseMode(req.query.mode);
  const snapshot = await getCurrentControlSnapshot();
  const staticTopicOrder = await getStaticTopicOrder(mode);
  const scheduleData = await recalculateSchedule({
    mode,
    staticTopicOrder,
    tuning: snapshot.calibration.tuning,
    forceIntervention: snapshot.forecast.riskSignal.intervention,
  });
  const today = scheduleData.date;

  await db.delete(schedulesTable).where(eq(schedulesTable.date, today));

  const [created] = await db
    .insert(schedulesTable)
    .values({
      date: today,
      scheduledHours: scheduleData.scheduledHours,
      blocks: JSON.stringify(scheduleData.blocks),
      daysUntilExam: scheduleData.daysUntilExam,
      isReset: scheduleData.isReset,
    })
    .returning();

  res.json({
    ...formatSchedule(created),
    overrideBudget: await getOverrideBudget(today),
    mode,
    riskSignal: scheduleData.riskSignal,
    control: snapshot,
  });
});

const swapBodySchema = z.object({
  blockIndex: z.number().int().min(0),
  chosenTopicId: z.number().int().min(1),
});

router.post("/schedule/today/swap", async (req, res): Promise<void> => {
  await ensureMasteryIntegrityOnLoad();
  const parsed = swapBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const [existing] = await db
    .select()
    .from(schedulesTable)
    .where(eq(schedulesTable.date, today))
    .orderBy(desc(schedulesTable.createdAt))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "No schedule found for today" });
    return;
  }

  const blocks = JSON.parse(existing.blocks ?? "[]") as Array<{
    topicId: number;
    topicName: string;
    subject: string;
    sessionType: "lecture" | "practice";
    durationMinutes: number;
    priorityScore: number;
    masteryScore: number;
    explanation?: unknown;
  }>;
  const currentBlock = blocks[parsed.data.blockIndex];
  if (!currentBlock) {
    res.status(400).json({ error: "Invalid block index" });
    return;
  }
  if (currentBlock.topicId === parsed.data.chosenTopicId) {
    const overrideBudget = await getOverrideBudget(today);
    res.json({
      ...formatSchedule(existing),
      overrideBudget,
      swap: { applied: false, reason: "no_change" },
    });
    return;
  }

  const [skippedTopic, chosenTopic] = await Promise.all([
    db.select().from(topicsTable).where(eq(topicsTable.id, currentBlock.topicId)).limit(1),
    db.select().from(topicsTable).where(eq(topicsTable.id, parsed.data.chosenTopicId)).limit(1),
  ]);
  if (!chosenTopic[0]) {
    res.status(404).json({ error: "Chosen topic not found" });
    return;
  }
  const allTopics = await db.select().from(topicsTable);
  const baseTopic = skippedTopic[0] ?? chosenTopic[0];
  const recommendedTopicIds = getRecommendedAlternatives(
    {
      id: baseTopic.id,
      subject: baseTopic.subject,
      difficultyLevel: baseTopic.difficultyLevel,
      priorityScore: baseTopic.priorityScore,
    },
    allTopics,
  );
  const wasRecommended = recommendedTopicIds.includes(parsed.data.chosenTopicId);

  const updatedBlocks = blocks.map((block, index) => {
    if (index !== parsed.data.blockIndex) return block;
    return {
      ...block,
      topicId: chosenTopic[0].id,
      topicName: chosenTopic[0].name,
      subject: chosenTopic[0].subject,
      masteryScore: chosenTopic[0].masteryScore,
      priorityScore: chosenTopic[0].priorityScore,
    };
  });

  const [updatedSchedule] = await db
    .update(schedulesTable)
    .set({ blocks: JSON.stringify(updatedBlocks) })
    .where(and(eq(schedulesTable.id, existing.id), eq(schedulesTable.date, today)))
    .returning();

  await db.insert(topicOverridesTable).values({
    scheduleDate: today,
    blockIndex: parsed.data.blockIndex,
    skippedTopicId: currentBlock.topicId,
    chosenTopicId: chosenTopic[0].id,
    wasRecommended,
  });
  const overrideBudget = await getOverrideBudget(today);

  res.json({
    ...formatSchedule(updatedSchedule ?? existing),
    overrideBudget,
    swap: {
      applied: true,
      skippedTopicId: currentBlock.topicId,
      chosenTopicId: chosenTopic[0].id,
      wasRecommended,
      recommendedTopicIds,
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
