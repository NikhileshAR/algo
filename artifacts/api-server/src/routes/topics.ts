import { Router, type IRouter } from "express";
import { db, topicsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { recomputePriorities, applyMasteryUpdate } from "../lib/scheduler";
import { logger } from "../lib/logger";
import { ensureMasteryIntegrityOnLoad } from "../lib/mastery-integrity";
import {
  CreateTopicBody,
  GetTopicParams,
  UpdateTopicBody,
  UpdateTopicParams,
  DeleteTopicParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatTopic(t: typeof topicsTable.$inferSelect) {
  return {
    ...t,
    prerequisites: JSON.parse(t.prerequisites ?? "[]") as number[],
    lastStudiedAt: t.lastStudiedAt ? t.lastStudiedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

router.get("/topics", async (_req, res): Promise<void> => {
  await ensureMasteryIntegrityOnLoad();
  const topics = await db.select().from(topicsTable).orderBy(topicsTable.priorityScore);
  res.json(topics.map(formatTopic).reverse());
});

router.post("/topics", async (req, res): Promise<void> => {
  const parsed = CreateTopicBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const rawMastery = parsed.data.masteryScore;
  if (rawMastery === undefined) {
    logger.warn({ topicName: parsed.data.name }, "Missing masteryScore in topic input; defaulting to 0.0");
  }

  if (rawMastery !== undefined && (!Number.isFinite(rawMastery) || rawMastery < 0 || rawMastery > 1)) {
    logger.warn({ topicName: parsed.data.name, masteryScore: rawMastery }, "Invalid masteryScore in topic input; rejecting");
    res.status(400).json({ error: "masteryScore must be a finite number in [0, 1]" });
    return;
  }

  const masteryScore = rawMastery ?? 0;

  const [topic] = await db
    .insert(topicsTable)
    .values({
      name: parsed.data.name,
      subject: parsed.data.subject,
      difficultyLevel: parsed.data.difficultyLevel,
      estimatedHours: parsed.data.estimatedHours,
      masteryScore,
      prerequisites: JSON.stringify(parsed.data.prerequisites ?? []),
    })
    .returning();

  await recomputePriorities();
  res.status(201).json(formatTopic(topic));
});

router.get("/topics/:id", async (req, res): Promise<void> => {
  const params = GetTopicParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [topic] = await db.select().from(topicsTable).where(eq(topicsTable.id, params.data.id));
  if (!topic) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }

  res.json(formatTopic(topic));
});

router.patch("/topics/:id", async (req, res): Promise<void> => {
  const params = UpdateTopicParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateTopicBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(topicsTable).where(eq(topicsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }

  const { testScore, testScoreMax, prerequisites, ...rest } = body.data;

  const updateData: Partial<typeof topicsTable.$inferInsert> = { ...rest, updatedAt: new Date() };
  if (prerequisites !== undefined) {
    updateData.prerequisites = JSON.stringify(prerequisites);
  }

  const [updated] = await db
    .update(topicsTable)
    .set(updateData)
    .where(eq(topicsTable.id, params.data.id))
    .returning();

  if (testScore !== undefined && testScoreMax !== undefined) {
    await applyMasteryUpdate(params.data.id, testScore, testScoreMax);
    const [refreshed] = await db.select().from(topicsTable).where(eq(topicsTable.id, params.data.id));
    res.json(formatTopic(refreshed));
    return;
  }

  await recomputePriorities();
  const [final] = await db.select().from(topicsTable).where(eq(topicsTable.id, params.data.id));
  res.json(formatTopic(final));
});

router.delete("/topics/:id", async (req, res): Promise<void> => {
  const params = DeleteTopicParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db.delete(topicsTable).where(eq(topicsTable.id, params.data.id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
