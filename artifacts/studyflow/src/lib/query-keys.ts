export const studyflowQueryKeys = {
  analyticsWeeklyReview: () => ["analytics", "weekly-review"] as const,
  analyticsWeeklyReviewSignals: () => ["analytics", "weekly-review", "signals"] as const,
  sessionsByTopic: (topicId: number) => ["sessions", "topic", topicId] as const,
};
