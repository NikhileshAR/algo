import { pgTable, text, serial, timestamp, real, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const studentProfileTable = pgTable("student_profile", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  examName: text("exam_name").notNull(),
  examDate: text("exam_date").notNull(),
  dailyTargetHours: real("daily_target_hours").notNull().default(4),
  capacityScore: real("capacity_score").notNull().default(4),
  disciplineScore: real("discipline_score").notNull().default(1),
  activePracticeRatio: real("active_practice_ratio").notNull().default(0.5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertStudentProfileSchema = createInsertSchema(studentProfileTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStudentProfile = z.infer<typeof insertStudentProfileSchema>;
export type StudentProfile = typeof studentProfileTable.$inferSelect;
