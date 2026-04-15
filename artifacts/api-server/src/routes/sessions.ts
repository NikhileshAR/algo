import { Router, type IRouter } from "express";
import { db, studySessionsTable, topicsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { applyMasteryUpdate, updateCapacityAndDiscipline } from "../lib/scheduler";
import {
  LogSessionBody,
  ListSessionsQueryParams,
  GetSessionParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatSession(s: typeof studySessionsTable.$inferSelect) {
  return {
    ...s,
    testScore: s.testScore ?? null,
    testScoreMax: s.testScoreMax ?? null,
    notes: s.notes ?? null,
    studiedAt: s.studiedAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
  };
}

router.get("/sessions", async (req, res): Promise<void> => {
  const parsed = ListSessionsQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 20) : 20;

  const sessions = await db
    .select()
    .from(studySessionsTable)
    .orderBy(desc(studySessionsTable.studiedAt))
    .limit(limit);

  res.json(sessions.map(formatSession));
});

router.post("/sessions", async (req, res): Promise<void> => {
  const parsed = LogSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [topic] = await db.select().from(topicsTable).where(eq(topicsTable.id, parsed.data.topicId));
  if (!topic) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }

  const studiedAt = parsed.data.studiedAt ? new Date(parsed.data.studiedAt) : new Date();

  const [session] = await db
    .insert(studySessionsTable)
    .values({
      topicId: parsed.data.topicId,
      topicName: topic.name,
      sessionType: parsed.data.sessionType,
      durationMinutes: parsed.data.durationMinutes,
      testScore: parsed.data.testScore ?? null,
      testScoreMax: parsed.data.testScoreMax ?? null,
      notes: parsed.data.notes ?? null,
      studiedAt,
    })
    .returning();

  await db
    .update(topicsTable)
    .set({ lastStudiedAt: new Date(), updatedAt: new Date() })
    .where(eq(topicsTable.id, parsed.data.topicId));

  if (parsed.data.testScore !== undefined && parsed.data.testScoreMax !== undefined) {
    await applyMasteryUpdate(parsed.data.topicId, parsed.data.testScore, parsed.data.testScoreMax);
  }

  const actualHours = parsed.data.durationMinutes / 60;
  await updateCapacityAndDiscipline(actualHours);

  res.status(201).json(formatSession(session));
});

router.get("/sessions/:id", async (req, res): Promise<void> => {
  const params = GetSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [session] = await db
    .select()
    .from(studySessionsTable)
    .where(eq(studySessionsTable.id, params.data.id));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json(formatSession(session));
});

export default router;
