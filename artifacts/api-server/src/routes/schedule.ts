import { Router, type IRouter } from "express";
import { db, schedulesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { recalculateSchedule } from "../lib/scheduler";

const router: IRouter = Router();

function formatSchedule(s: typeof schedulesTable.$inferSelect) {
  return {
    ...s,
    blocks: JSON.parse(s.blocks ?? "[]"),
    createdAt: s.createdAt.toISOString(),
  };
}

router.get("/schedule/today", async (req, res): Promise<void> => {
  const today = new Date().toISOString().split("T")[0];

  const [existing] = await db
    .select()
    .from(schedulesTable)
    .where(eq(schedulesTable.date, today))
    .orderBy(desc(schedulesTable.createdAt))
    .limit(1);

  if (existing) {
    res.json(formatSchedule(existing));
    return;
  }

  const scheduleData = await recalculateSchedule();

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

  res.json(formatSchedule(created));
});

router.post("/schedule/today", async (req, res): Promise<void> => {
  const scheduleData = await recalculateSchedule();
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

  res.json(formatSchedule(created));
});

export default router;
