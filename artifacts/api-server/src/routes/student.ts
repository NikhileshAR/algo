import { Router, type IRouter } from "express";
import { db, studentProfileTable } from "@workspace/db";
import { recomputePriorities } from "../lib/scheduler";
import {
  CreateStudentProfileBody,
  UpdateStudentProfileBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatProfile(p: typeof studentProfileTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

router.get("/student/profile", async (req, res): Promise<void> => {
  const [profile] = await db.select().from(studentProfileTable).limit(1);
  if (!profile) {
    res.status(404).json({ error: "No profile found" });
    return;
  }
  res.json(formatProfile(profile));
});

router.post("/student/profile", async (req, res): Promise<void> => {
  const parsed = CreateStudentProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await db.delete(studentProfileTable);
  const [profile] = await db
    .insert(studentProfileTable)
    .values({
      name: parsed.data.name,
      examName: parsed.data.examName,
      examDate: parsed.data.examDate,
      dailyTargetHours: parsed.data.dailyTargetHours,
      capacityScore: parsed.data.dailyTargetHours,
      disciplineScore: 1.0,
      activePracticeRatio: 0.5,
    })
    .returning();

  await recomputePriorities();
  res.status(201).json(formatProfile(profile));
});

router.patch("/student/profile", async (req, res): Promise<void> => {
  const parsed = UpdateStudentProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(studentProfileTable).limit(1);
  if (!existing) {
    res.status(404).json({ error: "No profile found" });
    return;
  }

  const [updated] = await db
    .update(studentProfileTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .returning();

  await recomputePriorities();
  res.json(formatProfile(updated));
});

export default router;
