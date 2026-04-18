import { Router, type IRouter } from "express";
import { db, schedulesTable, topicsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { recalculateSchedule, type SchedulerMode } from "../lib/scheduler";
import { getCurrentControlSnapshot } from "../lib/control-loop";
import { ensureMasteryIntegrityOnLoad } from "../lib/mastery-integrity";

const router: IRouter = Router();

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
    res.json({
      ...formatSchedule(existing),
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
    mode,
    riskSignal: scheduleData.riskSignal,
    control: snapshot,
  });
});

export default router;
