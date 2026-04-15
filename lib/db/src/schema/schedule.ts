import { pgTable, text, serial, timestamp, real, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const schedulesTable = pgTable("schedules", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  scheduledHours: real("scheduled_hours").notNull().default(0),
  blocks: text("blocks").notNull().default("[]"),
  daysUntilExam: integer("days_until_exam").notNull().default(0),
  isReset: boolean("is_reset").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertScheduleSchema = createInsertSchema(schedulesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
export type Schedule = typeof schedulesTable.$inferSelect;
