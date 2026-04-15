import { pgTable, text, serial, timestamp, real, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const studySessionsTable = pgTable("study_sessions", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id").notNull(),
  topicName: text("topic_name").notNull(),
  sessionType: text("session_type").notNull().default("lecture"),
  durationMinutes: integer("duration_minutes").notNull(),
  testScore: real("test_score"),
  testScoreMax: real("test_score_max"),
  notes: text("notes"),
  studiedAt: timestamp("studied_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertStudySessionSchema = createInsertSchema(studySessionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertStudySession = z.infer<typeof insertStudySessionSchema>;
export type StudySession = typeof studySessionsTable.$inferSelect;
