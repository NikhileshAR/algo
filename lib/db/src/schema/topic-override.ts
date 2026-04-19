import { pgTable, serial, integer, text, timestamp, boolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const topicOverridesTable = pgTable("topic_overrides", {
  id: serial("id").primaryKey(),
  scheduleDate: text("schedule_date").notNull(),
  blockIndex: integer("block_index").notNull(),
  skippedTopicId: integer("skipped_topic_id").notNull(),
  chosenTopicId: integer("chosen_topic_id").notNull(),
  wasRecommended: boolean("was_recommended").notNull().default(true),
  overrideIntent: text("override_intent").notNull().default("neutral_override"),
  impactScore: real("impact_score").notNull().default(0),
  isProductive: boolean("is_productive").notNull().default(false),
  skippedPriorityScore: real("skipped_priority_score").notNull().default(0),
  skippedDifficultyLevel: integer("skipped_difficulty_level").notNull().default(3),
  skippedMasteryScore: real("skipped_mastery_score").notNull().default(0),
  chosenPriorityScore: real("chosen_priority_score").notNull().default(0),
  chosenDifficultyLevel: integer("chosen_difficulty_level").notNull().default(3),
  chosenMasteryScore: real("chosen_mastery_score").notNull().default(0),
  reflectionOutcome: text("reflection_outcome"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTopicOverrideSchema = createInsertSchema(topicOverridesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertTopicOverride = z.infer<typeof insertTopicOverrideSchema>;
export type TopicOverride = typeof topicOverridesTable.$inferSelect;
