import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const topicOverridesTable = pgTable("topic_overrides", {
  id: serial("id").primaryKey(),
  scheduleDate: text("schedule_date").notNull(),
  blockIndex: integer("block_index").notNull(),
  skippedTopicId: integer("skipped_topic_id").notNull(),
  chosenTopicId: integer("chosen_topic_id").notNull(),
  wasRecommended: boolean("was_recommended").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTopicOverrideSchema = createInsertSchema(topicOverridesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertTopicOverride = z.infer<typeof insertTopicOverrideSchema>;
export type TopicOverride = typeof topicOverridesTable.$inferSelect;
