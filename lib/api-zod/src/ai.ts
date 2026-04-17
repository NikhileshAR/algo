import * as z from "zod";

export const AiOnboardingEnrichBody = z.object({
  subjects: z.array(z.string()).min(1, "At least one subject is required"),
  currentLevel: z.enum(["beginner", "intermediate", "advanced"]),
  specificGoals: z.string().optional(),
});

export type AiOnboardingEnrichBodyType = z.infer<typeof AiOnboardingEnrichBody>;

export const AiSuggestedTopic = z.object({
  name: z.string(),
  subject: z.string(),
  difficultyLevel: z.number().int().min(1).max(5),
  estimatedHours: z.number().positive(),
  masteryScore: z.number().min(0).max(1),
});

export type AiSuggestedTopicType = z.infer<typeof AiSuggestedTopic>;

export const AiOnboardingEnrichResponse = z.object({
  studyStrategy: z.string(),
  scheduleTone: z.enum(["aggressive", "balanced", "relaxed"]),
  suggestedTopics: z.array(AiSuggestedTopic).min(1),
});

export type AiOnboardingEnrichResponseType = z.infer<typeof AiOnboardingEnrichResponse>;
