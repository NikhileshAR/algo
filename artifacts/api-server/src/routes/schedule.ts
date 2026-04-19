import { Router, type IRouter } from "express";
import { db, schedulesTable, studySessionsTable, topicOverridesTable, topicsTable } from "@workspace/db";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { recalculateSchedule, type PlannerRiskSignal, type SchedulerMode } from "../lib/scheduler";
import { getCurrentControlSnapshot } from "../lib/control-loop";
import { ensureMasteryIntegrityOnLoad } from "../lib/mastery-integrity";
import { z } from "zod/v4";

const router: IRouter = Router();
const SWAP_SOFT_LIMIT_PER_DAY = 2;
const RESISTANCE_SKIP_THRESHOLD = 3;
const RESISTANCE_WINDOW_DAYS = 14;
const INTEGRITY_GUIDANCE_THRESHOLD = 0.55;

type OverrideIntent = "productive_override" | "avoidance_override" | "neutral_override";

interface SwapCandidate {
  id: number;
  subject: string;
  difficultyLevel: number;
  priorityScore: number;
  masteryScore: number;
  lastStudiedAt: Date | null;
}

interface ScheduleBlockPayload {
  topicId: number;
  topicName: string;
  subject: string;
  sessionType: "lecture" | "practice";
  durationMinutes: number;
  priorityScore: number;
  masteryScore: number;
  explanation?: unknown;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatSchedule(s: typeof schedulesTable.$inferSelect) {
  return {
    ...s,
    blocks: JSON.parse(s.blocks ?? "[]"),
    createdAt: s.createdAt.toISOString(),
  };
}

function parseBlocks(raw: string | null): ScheduleBlockPayload[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed as ScheduleBlockPayload[] : [];
  } catch {
    return [];
  }
}

function parseMode(raw: unknown): SchedulerMode {
  if (raw === "static" || raw === "random" || raw === "adaptive") {
    return raw;
  }
  return "adaptive";
}

function hoursSinceStudied(lastStudiedAt: Date | null): number {
  if (!lastStudiedAt) return 9999;
  return (Date.now() - new Date(lastStudiedAt).getTime()) / (1000 * 60 * 60);
}

function scoreSwapCandidate(current: SwapCandidate, candidate: SwapCandidate, blockIndex: number): number {
  const sameSubjectContinuity = candidate.subject === current.subject ? 1 : 0;
  const weakAreaPriority = clamp(1 - candidate.masteryScore, 0, 1);
  const prioritySimilarity = 1 - clamp(Math.abs(candidate.priorityScore - current.priorityScore), 0, 1);
  const fatigueCompatibility = blockIndex >= 2
    ? 1 - clamp(candidate.difficultyLevel / 5, 0, 1)
    : clamp(candidate.difficultyLevel / 5, 0, 1);
  const spacingHours = hoursSinceStudied(candidate.lastStudiedAt);
  const spacingBonus = spacingHours < 12
    ? 0
    : spacingHours <= 96
      ? 1
      : 0.55;
  return (
    sameSubjectContinuity * 0.32 +
    weakAreaPriority * 0.22 +
    prioritySimilarity * 0.2 +
    fatigueCompatibility * 0.14 +
    spacingBonus * 0.12
  );
}

function getRecommendedAlternatives(
  current: SwapCandidate,
  topics: Array<typeof topicsTable.$inferSelect>,
  blockIndex: number,
): number[] {
  return topics
    .filter((topic) => topic.id !== current.id && !topic.isCompleted)
    .map((topic) => ({
      id: topic.id,
      score: scoreSwapCandidate(current, {
        id: topic.id,
        subject: topic.subject,
        difficultyLevel: topic.difficultyLevel,
        priorityScore: topic.priorityScore,
        masteryScore: topic.masteryScore,
        lastStudiedAt: topic.lastStudiedAt,
      }, blockIndex),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.id);
}

function classifyImpactLevel(impactScore: number): "LOW" | "MEDIUM" | "HIGH" {
  if (impactScore >= 2.35) return "HIGH";
  if (impactScore >= 1.1) return "MEDIUM";
  return "LOW";
}

function qualityFromSession(session: typeof studySessionsTable.$inferSelect): number {
  const normalizedScore =
    session.testScore !== null && session.testScoreMax !== null
      ? clamp(session.testScore / Math.max(session.testScoreMax, 1), 0, 1)
      : null;
  const focusQuality = clamp(
    1 - (session.distractionMinutes ?? 0) / Math.max(session.durationMinutes, 1),
    0,
    1,
  );
  const durationQuality = clamp(session.durationMinutes / 45, 0.4, 1);
  if (normalizedScore === null) {
    return clamp(focusQuality * 0.75 + durationQuality * 0.25, 0, 1);
  }
  return clamp(normalizedScore * 0.6 + focusQuality * 0.25 + durationQuality * 0.15, 0, 1);
}

function classifyOverride(params: {
  skippedTopic: typeof topicsTable.$inferSelect;
  chosenTopic: typeof topicsTable.$inferSelect;
  sessionType: "lecture" | "practice";
  repeatedSkips: number;
  reflectionBias: number;
}): { intent: OverrideIntent; isProductive: boolean; impactScore: number } {
  const priorityDelta = (params.chosenTopic.priorityScore ?? 0) - (params.skippedTopic.priorityScore ?? 0);
  const difficultyDelta = params.chosenTopic.difficultyLevel - params.skippedTopic.difficultyLevel;
  const masteryDelta = params.chosenTopic.masteryScore - params.skippedTopic.masteryScore;
  const weakAreaMove = params.chosenTopic.masteryScore < params.skippedTopic.masteryScore - 0.05;
  const higherPriorityMove = priorityDelta >= 0.08;
  const activePracticeMove = params.sessionType === "practice" && params.chosenTopic.masteryScore <= 0.65;
  const isProductive = higherPriorityMove || weakAreaMove || activePracticeMove;

  const avoidancePattern =
    priorityDelta < -0.12 &&
    difficultyDelta <= -1 &&
    masteryDelta > 0.08 &&
    params.repeatedSkips >= 1;

  const intent: OverrideIntent = isProductive
    ? "productive_override"
    : avoidancePattern
      ? "avoidance_override"
      : "neutral_override";

  const skippedUrgency = clamp(
    (1 - params.skippedTopic.masteryScore) * 0.6 + (params.skippedTopic.difficultyLevel / 5) * 0.4,
    0,
    1,
  );
  const skippedPriorityWeight = clamp(params.skippedTopic.priorityScore, 0, 1.5);
  const repetitionPenalty = clamp(params.repeatedSkips / 4, 0, 1);
  const intentPenalty = intent === "avoidance_override" ? 0.4 : intent === "productive_override" ? -0.2 : 0;
  const impactScore = clamp(
    skippedPriorityWeight * 1.1 +
      skippedUrgency * 0.95 +
      repetitionPenalty * 0.75 +
      intentPenalty -
      params.reflectionBias * 0.25,
    0,
    3,
  );

  return {
    intent,
    isProductive,
    impactScore: Math.round(impactScore * 1000) / 1000,
  };
}

async function getOverrideIntelligence(scheduleDate: string): Promise<{
  used: number;
  softLimit: number;
  effectiveUsed: number;
  autonomyCredit: number;
  frictionStage: "free" | "warning" | "confirm" | "nudge_stop";
  requiresConfirmation: boolean;
  impactScore: number;
  impactLabel: "LOW" | "MEDIUM" | "HIGH";
  delayedHighPriorityTopics: number;
  delayedTopicIds: number[];
  productiveOverrides: number;
  avoidanceOverrides: number;
}> {
  const rows = await db
    .select()
    .from(topicOverridesTable)
    .where(eq(topicOverridesTable.scheduleDate, scheduleDate));

  const used = rows.length;
  const productiveOverrides = rows.filter((row) => row.overrideIntent === "productive_override").length;
  const avoidanceOverrides = rows.filter((row) => row.overrideIntent === "avoidance_override").length;
  const autonomyCredit = Math.min(1, Math.floor(productiveOverrides / 2));
  const effectiveUsed = Math.max(0, used - autonomyCredit);
  const impactScore = rows.reduce((sum, row) => sum + (row.impactScore ?? 0), 0);
  const delayedTopicIds = rows
    .filter((row) => (row.skippedPriorityScore ?? 0) >= 0.65)
    .map((row) => row.skippedTopicId);
  const delayedHighPriorityTopics = new Set(delayedTopicIds).size;
  const frictionStage = effectiveUsed <= 0
    ? "free"
    : effectiveUsed === 1
      ? "warning"
      : effectiveUsed === 2
        ? "confirm"
        : "nudge_stop";
  return {
    used,
    softLimit: SWAP_SOFT_LIMIT_PER_DAY,
    effectiveUsed,
    autonomyCredit,
    frictionStage,
    requiresConfirmation: frictionStage === "confirm" || frictionStage === "nudge_stop",
    impactScore: Math.round(impactScore * 1000) / 1000,
    impactLabel: classifyImpactLevel(impactScore),
    delayedHighPriorityTopics,
    delayedTopicIds,
    productiveOverrides,
    avoidanceOverrides,
  };
}

async function getResistanceSignals(scheduleDate: string): Promise<Array<{
  topicId: number;
  topicName: string;
  skipCount: number;
  suggestedEntryMinutes: number;
  forceIncludeWithinDays: number;
  reframingLabel: string;
}>> {
  const windowStart = new Date(`${scheduleDate}T00:00:00.000Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - RESISTANCE_WINDOW_DAYS);
  const startDay = windowStart.toISOString().split("T")[0];
  const recentOverrides = await db
    .select()
    .from(topicOverridesTable)
    .where(and(gte(topicOverridesTable.scheduleDate, startDay), lte(topicOverridesTable.scheduleDate, scheduleDate)));
  const skipCounts = new Map<number, number>();
  for (const override of recentOverrides) {
    skipCounts.set(override.skippedTopicId, (skipCounts.get(override.skippedTopicId) ?? 0) + 1);
  }
  const resistedIds = [...skipCounts.entries()]
    .filter(([, count]) => count >= RESISTANCE_SKIP_THRESHOLD)
    .map(([topicId]) => topicId);
  if (resistedIds.length === 0) return [];
  const topics = await db.select().from(topicsTable);
  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
  return resistedIds.map((topicId) => ({
    topicId,
    topicName: topicMap.get(topicId)?.name ?? `Topic ${topicId}`,
    skipCount: skipCounts.get(topicId) ?? 0,
    suggestedEntryMinutes: 15,
    forceIncludeWithinDays: 2,
    reframingLabel: "Start small — just 15 min",
  }));
}

async function computeDailyPlanIntegrity(scheduleDate: string): Promise<{
  score: number;
  label: "LOW" | "MEDIUM" | "HIGH";
  guidance: "more_structure" | "balanced" | "more_flexibility";
}> {
  const [schedule] = await db
    .select()
    .from(schedulesTable)
    .where(eq(schedulesTable.date, scheduleDate))
    .orderBy(desc(schedulesTable.createdAt))
    .limit(1);
  if (!schedule) {
    return { score: 1, label: "HIGH", guidance: "more_flexibility" };
  }
  const blocks = parseBlocks(schedule.blocks);
  const scheduledMinutes = blocks.reduce((sum, block) => sum + Math.max(block.durationMinutes, 0), 0);
  const dayStart = new Date(`${scheduleDate}T00:00:00.000Z`);
  const dayEnd = new Date(`${scheduleDate}T23:59:59.999Z`);
  const sessions = await db
    .select()
    .from(studySessionsTable)
    .where(and(gte(studySessionsTable.studiedAt, dayStart), lte(studySessionsTable.studiedAt, dayEnd)));
  const actualMinutes = sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
  const averageQuality = sessions.length > 0
    ? sessions.reduce((sum, session) => sum + qualityFromSession(session), 0) / sessions.length
    : 0.5;
  const overrides = await db.select().from(topicOverridesTable).where(eq(topicOverridesTable.scheduleDate, scheduleDate));
  const impactPenalty = clamp(
    overrides.reduce((sum, row) => sum + (row.impactScore ?? 0), 0) / Math.max(3, blocks.length * 1.6),
    0,
    1,
  );
  const skippedPriorityPenalty = clamp(
    overrides.reduce((sum, row) => sum + (row.skippedPriorityScore ?? 0), 0) / Math.max(2, overrides.length * 0.95),
    0,
    1,
  );
  const adherence = scheduledMinutes > 0 ? clamp(actualMinutes / scheduledMinutes, 0, 1) : 1;
  const score = clamp(
    adherence * 0.5 +
    averageQuality * 0.22 +
    (1 - impactPenalty) * 0.16 +
    (1 - skippedPriorityPenalty) * 0.12,
    0,
    1,
  );
  const label: "LOW" | "MEDIUM" | "HIGH" = score >= 0.78 ? "HIGH" : score >= 0.55 ? "MEDIUM" : "LOW";
  const guidance = score < INTEGRITY_GUIDANCE_THRESHOLD
    ? "more_structure"
    : score >= 0.8
      ? "more_flexibility"
      : "balanced";
  return {
    score: Math.round(score * 1000) / 1000,
    label,
    guidance,
  };
}

function tightenIntervention(
  baseIntervention: PlannerRiskSignal["intervention"],
  overrideIntel: Awaited<ReturnType<typeof getOverrideIntelligence>>,
  integrity: Awaited<ReturnType<typeof computeDailyPlanIntegrity>>,
): PlannerRiskSignal["intervention"] {
  if (baseIntervention === "early_reset") return baseIntervention;
  if (overrideIntel.impactLabel === "HIGH" || integrity.score < 0.45) {
    return baseIntervention === "none" ? "priority_concentration" : baseIntervention;
  }
  if (overrideIntel.impactLabel === "MEDIUM" || integrity.score < INTEGRITY_GUIDANCE_THRESHOLD) {
    if (baseIntervention === "none") return "reduced_targets";
  }
  return baseIntervention;
}

async function getStaticTopicOrder(mode: SchedulerMode): Promise<number[] | undefined> {
  if (mode !== "static") {
    return undefined;
  }
  const topics = await db.select().from(topicsTable).orderBy(desc(topicsTable.priorityScore));
  return topics.map((topic) => topic.id);
}

const swapBodySchema = z.object({
  blockIndex: z.number().int().min(0),
  chosenTopicId: z.number().int().min(1),
});

const reflectionSchema = z.object({
  overrideId: z.number().int().min(1),
  outcome: z.enum(["yes", "neutral", "no"]),
});

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
    const [overrideBudget, resistanceSignals, planIntegrity] = await Promise.all([
      getOverrideIntelligence(existing.date),
      getResistanceSignals(existing.date),
      computeDailyPlanIntegrity(existing.date),
    ]);
    res.json({
      ...formatSchedule(existing),
      overrideBudget,
      resistanceSignals,
      planIntegrity,
      control: snapshot,
      overrideImpact: {
        score: overrideBudget.impactScore,
        label: overrideBudget.impactLabel,
        delayedHighPriorityTopics: overrideBudget.delayedHighPriorityTopics,
      },
    });
    return;
  }

  const mode = parseMode(req.query.mode);
  const [snapshot, overrideIntel, planIntegrity] = await Promise.all([
    getCurrentControlSnapshot(),
    getOverrideIntelligence(today),
    computeDailyPlanIntegrity(today),
  ]);
  const staticTopicOrder = await getStaticTopicOrder(mode);
  const scheduleData = await recalculateSchedule({
    mode,
    staticTopicOrder,
    tuning: snapshot.calibration.tuning,
    forceIntervention: tightenIntervention(snapshot.forecast.riskSignal.intervention, overrideIntel, planIntegrity),
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

  const [createdOverrideBudget, resistanceSignals, createdPlanIntegrity] = await Promise.all([
    getOverrideIntelligence(today),
    getResistanceSignals(today),
    computeDailyPlanIntegrity(today),
  ]);

  res.json({
    ...formatSchedule(created),
    overrideBudget: createdOverrideBudget,
    resistanceSignals,
    planIntegrity: createdPlanIntegrity,
    mode,
    riskSignal: scheduleData.riskSignal,
    overrideImpact: {
      score: createdOverrideBudget.impactScore,
      label: createdOverrideBudget.impactLabel,
      delayedHighPriorityTopics: createdOverrideBudget.delayedHighPriorityTopics,
    },
    control: snapshot,
  });
});

router.post("/schedule/today", async (req, res): Promise<void> => {
  await ensureMasteryIntegrityOnLoad();
  const mode = parseMode(req.query.mode);
  const today = new Date().toISOString().split("T")[0];
  const [snapshot, overrideIntel, planIntegrity] = await Promise.all([
    getCurrentControlSnapshot(),
    getOverrideIntelligence(today),
    computeDailyPlanIntegrity(today),
  ]);
  const staticTopicOrder = await getStaticTopicOrder(mode);
  const scheduleData = await recalculateSchedule({
    mode,
    staticTopicOrder,
    tuning: snapshot.calibration.tuning,
    forceIntervention: tightenIntervention(snapshot.forecast.riskSignal.intervention, overrideIntel, planIntegrity),
  });

  await db.delete(schedulesTable).where(eq(schedulesTable.date, scheduleData.date));

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

  const [overrideBudget, resistanceSignals, updatedIntegrity] = await Promise.all([
    getOverrideIntelligence(scheduleData.date),
    getResistanceSignals(scheduleData.date),
    computeDailyPlanIntegrity(scheduleData.date),
  ]);

  res.json({
    ...formatSchedule(created),
    overrideBudget,
    resistanceSignals,
    planIntegrity: updatedIntegrity,
    mode,
    riskSignal: scheduleData.riskSignal,
    overrideImpact: {
      score: overrideBudget.impactScore,
      label: overrideBudget.impactLabel,
      delayedHighPriorityTopics: overrideBudget.delayedHighPriorityTopics,
    },
    control: snapshot,
  });
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

  const blocks = parseBlocks(existing.blocks);
  const currentBlock = blocks[parsed.data.blockIndex];
  if (!currentBlock) {
    res.status(400).json({ error: "Invalid block index" });
    return;
  }

  const overrideBudgetBefore = await getOverrideIntelligence(today);
  if (overrideBudgetBefore.requiresConfirmation && req.body?.confirmed !== true) {
    res.status(409).json({
      error: "Swap confirmation required",
      overrideBudget: overrideBudgetBefore,
    });
    return;
  }

  if (currentBlock.topicId === parsed.data.chosenTopicId) {
    const [overrideBudget, resistanceSignals, planIntegrity] = await Promise.all([
      getOverrideIntelligence(today),
      getResistanceSignals(today),
      computeDailyPlanIntegrity(today),
    ]);
    res.json({
      ...formatSchedule(existing),
      overrideBudget,
      resistanceSignals,
      planIntegrity,
      overrideImpact: {
        score: overrideBudget.impactScore,
        label: overrideBudget.impactLabel,
        delayedHighPriorityTopics: overrideBudget.delayedHighPriorityTopics,
      },
      swap: { applied: false, reason: "no_change" },
    });
    return;
  }

  const [skippedTopic, chosenTopic, allTopics, historicalOverrides] = await Promise.all([
    db.select().from(topicsTable).where(eq(topicsTable.id, currentBlock.topicId)).limit(1),
    db.select().from(topicsTable).where(eq(topicsTable.id, parsed.data.chosenTopicId)).limit(1),
    db.select().from(topicsTable),
    db.select().from(topicOverridesTable).where(eq(topicOverridesTable.skippedTopicId, currentBlock.topicId)),
  ]);
  if (!chosenTopic[0]) {
    res.status(404).json({ error: "Chosen topic not found" });
    return;
  }
  if (!skippedTopic[0]) {
    res.status(404).json({ error: "Skipped topic not found" });
    return;
  }

  const baseTopic = skippedTopic[0];
  const recommendedTopicIds = getRecommendedAlternatives(
    {
      id: baseTopic.id,
      subject: baseTopic.subject,
      difficultyLevel: baseTopic.difficultyLevel,
      priorityScore: baseTopic.priorityScore,
      masteryScore: baseTopic.masteryScore,
      lastStudiedAt: baseTopic.lastStudiedAt,
    },
    allTopics,
    parsed.data.blockIndex,
  );
  const wasRecommended = recommendedTopicIds.includes(parsed.data.chosenTopicId);
  const reflectionBias = historicalOverrides.length > 0
    ? historicalOverrides.reduce((sum, row) => {
      if (row.reflectionOutcome === "yes") return sum + 1;
      if (row.reflectionOutcome === "no") return sum - 1;
      return sum;
    }, 0) / historicalOverrides.length
    : 0;
  const classified = classifyOverride({
    skippedTopic: baseTopic,
    chosenTopic: chosenTopic[0],
    sessionType: currentBlock.sessionType,
    repeatedSkips: historicalOverrides.length,
    reflectionBias,
  });

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

  const [insertedOverride] = await db
    .insert(topicOverridesTable)
    .values({
      scheduleDate: today,
      blockIndex: parsed.data.blockIndex,
      skippedTopicId: currentBlock.topicId,
      chosenTopicId: chosenTopic[0].id,
      wasRecommended,
      overrideIntent: classified.intent,
      impactScore: classified.impactScore,
      isProductive: classified.isProductive,
      skippedPriorityScore: skippedTopic[0].priorityScore,
      skippedDifficultyLevel: skippedTopic[0].difficultyLevel,
      skippedMasteryScore: skippedTopic[0].masteryScore,
      chosenPriorityScore: chosenTopic[0].priorityScore,
      chosenDifficultyLevel: chosenTopic[0].difficultyLevel,
      chosenMasteryScore: chosenTopic[0].masteryScore,
    })
    .returning();

  const [overrideBudget, resistanceSignals, planIntegrity] = await Promise.all([
    getOverrideIntelligence(today),
    getResistanceSignals(today),
    computeDailyPlanIntegrity(today),
  ]);

  res.json({
    ...formatSchedule(updatedSchedule ?? existing),
    overrideBudget,
    resistanceSignals,
    planIntegrity,
    overrideImpact: {
      score: overrideBudget.impactScore,
      label: overrideBudget.impactLabel,
      delayedHighPriorityTopics: overrideBudget.delayedHighPriorityTopics,
    },
    swap: {
      applied: true,
      skippedTopicId: currentBlock.topicId,
      chosenTopicId: chosenTopic[0].id,
      wasRecommended,
      recommendedTopicIds,
      overrideId: insertedOverride?.id,
      intent: classified.intent,
      impactScore: classified.impactScore,
      impactLabel: classifyImpactLevel(classified.impactScore),
      isProductive: classified.isProductive,
      timestamp: new Date().toISOString(),
    },
  });
});

router.post("/schedule/overrides/reflection", async (req, res): Promise<void> => {
  const parsed = reflectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [override] = await db
    .select()
    .from(topicOverridesTable)
    .where(eq(topicOverridesTable.id, parsed.data.overrideId))
    .limit(1);
  if (!override) {
    res.status(404).json({ error: "Override not found" });
    return;
  }
  const [updated] = await db
    .update(topicOverridesTable)
    .set({ reflectionOutcome: parsed.data.outcome })
    .where(eq(topicOverridesTable.id, parsed.data.overrideId))
    .returning();
  res.json({
    overrideId: updated?.id ?? parsed.data.overrideId,
    outcome: updated?.reflectionOutcome ?? parsed.data.outcome,
  });
});

export default router;
