import { pgTable, text, serial, timestamp, real, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const topicsTable = pgTable("topics", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  masteryScore: real("mastery_score").notNull().default(0),
  confidenceScore: real("confidence_score").notNull().default(0),
  priorityScore: real("priority_score").notNull().default(0),
  difficultyLevel: integer("difficulty_level").notNull().default(3),
  estimatedHours: real("estimated_hours").notNull().default(5),
  prerequisites: text("prerequisites").notNull().default("[]"),
  isCompleted: boolean("is_completed").notNull().default(false),
  testsCount: integer("tests_count").notNull().default(0),
  lastStudiedAt: timestamp("last_studied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertTopicSchema = createInsertSchema(topicsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTopic = z.infer<typeof insertTopicSchema>;
export type Topic = typeof topicsTable.$inferSelect;
